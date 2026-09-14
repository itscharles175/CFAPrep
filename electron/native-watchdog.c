#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_TRACKED 64
#define INPUT_CAP 4096

typedef struct {
  pid_t pid;
  uint64_t start_seconds;
  uint64_t start_microseconds;
  bool active;
} tracked_process;

static pid_t parent_pid = 0;
static uint64_t parent_start_seconds = 0;
static uint64_t parent_start_microseconds = 0;
static tracked_process tracked[MAX_TRACKED];
static volatile sig_atomic_t stop_requested = 0;

static void request_stop(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
}

static bool process_identity(pid_t pid, pid_t *ppid, uint64_t *seconds, uint64_t *microseconds) {
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
  if (size != (int)sizeof(info)) return false;
  if (ppid != NULL) *ppid = (pid_t)info.pbi_ppid;
  *seconds = (uint64_t)info.pbi_start_tvsec;
  *microseconds = (uint64_t)info.pbi_start_tvusec;
  return *seconds != 0 || *microseconds != 0;
}

static bool parent_is_original(void) {
  pid_t ignored_parent = 0;
  uint64_t seconds = 0;
  uint64_t microseconds = 0;
  return process_identity(parent_pid, &ignored_parent, &seconds, &microseconds) &&
         seconds == parent_start_seconds && microseconds == parent_start_microseconds;
}

static tracked_process *find_tracked(pid_t pid) {
  for (size_t index = 0; index < MAX_TRACKED; index += 1) {
    if (tracked[index].active && tracked[index].pid == pid) return &tracked[index];
  }
  return NULL;
}

static bool track_pid(pid_t pid) {
  if (pid <= 1 || pid == parent_pid || pid == getpid() || find_tracked(pid) != NULL) return false;
  pid_t actual_parent = 0;
  uint64_t seconds = 0;
  uint64_t microseconds = 0;
  if (!process_identity(pid, &actual_parent, &seconds, &microseconds) || actual_parent != parent_pid) return false;
  for (size_t index = 0; index < MAX_TRACKED; index += 1) {
    if (tracked[index].active) continue;
    tracked[index] = (tracked_process){
      .pid = pid,
      .start_seconds = seconds,
      .start_microseconds = microseconds,
      .active = true,
    };
    return true;
  }
  return false;
}

static void untrack_pid(pid_t pid) {
  tracked_process *record = find_tracked(pid);
  if (record != NULL) record->active = false;
}

static void kill_if_still_owned(tracked_process *record) {
  pid_t ignored_parent = 0;
  uint64_t seconds = 0;
  uint64_t microseconds = 0;
  if (!record->active || !process_identity(record->pid, &ignored_parent, &seconds, &microseconds)) return;
  if (seconds != record->start_seconds || microseconds != record->start_microseconds) return;
  if (kill(-record->pid, SIGKILL) != 0 && errno != ESRCH) (void)kill(record->pid, SIGKILL);
}

static void reap_owned(void) {
  for (size_t index = 0; index < MAX_TRACKED; index += 1) {
    kill_if_still_owned(&tracked[index]);
    tracked[index].active = false;
  }
}

static long json_integer(const char *line, const char *key, long fallback) {
  const char *found = strstr(line, key);
  if (found == NULL) return fallback;
  found += strlen(key);
  while (*found == ' ' || *found == '\t' || *found == ':') found += 1;
  char *end = NULL;
  errno = 0;
  long value = strtol(found, &end, 10);
  return errno == 0 && end != found ? value : fallback;
}

static void respond(long id, bool ok) {
  if (id < 1) return;
  (void)printf("{\"id\":%ld,\"ok\":%s}\n", id, ok ? "true" : "false");
  (void)fflush(stdout);
}

static bool handle_line(const char *line) {
  long id = json_integer(line, "\"id\"", -1);
  if (strstr(line, "\"op\":\"track\"") != NULL) {
    long pid = json_integer(line, "\"pid\"", -1);
    respond(id, pid > 0 && pid <= INT32_MAX && track_pid((pid_t)pid));
    return false;
  }
  if (strstr(line, "\"op\":\"untrack\"") != NULL) {
    long pid = json_integer(line, "\"pid\"", -1);
    if (pid > 0 && pid <= INT32_MAX) untrack_pid((pid_t)pid);
    respond(id, pid > 0 && pid <= INT32_MAX);
    return false;
  }
  if (strstr(line, "\"op\":\"shutdown\"") != NULL) {
    respond(id, true);
    return true;
  }
  respond(id, false);
  return false;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long parsed_parent = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end != '\0' || parsed_parent <= 1 || parsed_parent > INT32_MAX) return 2;
  parent_pid = (pid_t)parsed_parent;
  pid_t ignored_parent = 0;
  if (!process_identity(parent_pid, &ignored_parent, &parent_start_seconds, &parent_start_microseconds)) return 3;

  signal(SIGTERM, request_stop);
  signal(SIGINT, request_stop);
  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  (void)printf("STUDYVAULT_WATCHDOG_READY\n");

  char input[INPUT_CAP];
  size_t used = 0;
  while (!stop_requested && parent_is_original()) {
    fd_set read_set;
    FD_ZERO(&read_set);
    FD_SET(STDIN_FILENO, &read_set);
    struct timeval timeout = {.tv_sec = 0, .tv_usec = 100000};
    int ready = select(STDIN_FILENO + 1, &read_set, NULL, NULL, &timeout);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ready == 0) continue;
    ssize_t count = read(STDIN_FILENO, input + used, sizeof(input) - used - 1);
    if (count <= 0) break;
    used += (size_t)count;
    input[used] = '\0';
    char *line_start = input;
    char *newline = NULL;
    while ((newline = strchr(line_start, '\n')) != NULL) {
      *newline = '\0';
      if (handle_line(line_start)) {
        reap_owned();
        return 0;
      }
      line_start = newline + 1;
    }
    size_t remaining = used - (size_t)(line_start - input);
    memmove(input, line_start, remaining);
    used = remaining;
    if (used == sizeof(input) - 1) used = 0;
  }
  reap_owned();
  return 0;
}
