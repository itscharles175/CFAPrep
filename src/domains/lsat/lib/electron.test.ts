import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StudyVaultBridge, StudyVaultFileDescriptor, StudyVaultPathEvent } from '@/lib/desktopBridge';
import { listenOpenFile, listenTrayNavigate, pickPdfFile } from '@lsat/lib/electron';

type LaunchDrain = () => Promise<{ paths?: unknown } | null>;

/** Install a minimal `window.studyvault` and hand back emitters for its events. */
function installBridge(options: { takeLaunchFiles?: LaunchDrain; picked?: StudyVaultFileDescriptor[] } = {}) {
  const openFileListeners = new Set<(event: StudyVaultPathEvent) => void>();
  const secondInstanceListeners = new Set<(event: { argv: string[]; cwd: string; paths: string[] }) => void>();

  const files: Record<string, unknown> = {
    pickFolder: vi.fn(async () => null),
    pickFiles: vi.fn(async () => options.picked ?? []),
    listPdfs: vi.fn(async () => []),
    read: vi.fn(async (path: string) => ({
      path,
      name: path.split(/[/\\]/).pop() ?? '',
      extension: '.pdf',
      size: 3,
      data: new Uint8Array([1, 2, 3]),
    })),
  };
  if (options.takeLaunchFiles) files.takeLaunchFiles = options.takeLaunchFiles;

  window.studyvault = {
    files,
    events: {
      onBootStatus: () => () => {},
      onPdfDrop: () => () => {},
      onOpenFile: (listener: (event: StudyVaultPathEvent) => void) => {
        openFileListeners.add(listener);
        return () => openFileListeners.delete(listener);
      },
      onSecondInstance: (listener: (event: { argv: string[]; cwd: string; paths: string[] }) => void) => {
        secondInstanceListeners.add(listener);
        return () => secondInstanceListeners.delete(listener);
      },
    },
  } as unknown as StudyVaultBridge;

  return {
    emitOpenFile: (paths: string[]) => {
      for (const listener of openFileListeners) listener({ paths });
    },
    emitSecondInstance: (argv: string[]) => {
      for (const listener of secondInstanceListeners) listener({ argv, cwd: '/home/user', paths: [] });
    },
  };
}

afterEach(() => {
  delete window.studyvault;
  vi.clearAllMocks();
});

describe('listenOpenFile', () => {
  it('drains a cold-start launch file the main process emitted before registration', async () => {
    installBridge({ takeLaunchFiles: async () => ({ paths: ['/launch/PT99.pdf'] }) });
    const onFile = vi.fn();

    listenOpenFile(onFile);

    await vi.waitFor(() => expect(onFile).toHaveBeenCalledWith('/launch/PT99.pdf'));
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('swallows the drained path echoing back once, but honors a later re-open', async () => {
    const bridge = installBridge({ takeLaunchFiles: async () => ({ paths: ['/launch/PT99.pdf'] }) });
    const onFile = vi.fn();

    listenOpenFile(onFile);
    await vi.waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));

    bridge.emitOpenFile(['/launch/PT99.pdf']);
    expect(onFile).toHaveBeenCalledTimes(1);

    bridge.emitOpenFile(['/launch/PT99.pdf']);
    expect(onFile).toHaveBeenCalledTimes(2);
  });

  it('still delivers event handoffs when the preload has no drain channel', () => {
    const bridge = installBridge();
    const onFile = vi.fn();

    listenOpenFile(onFile);
    bridge.emitOpenFile(['/second/PT100.pdf']);

    expect(onFile).toHaveBeenCalledWith('/second/PT100.pdf');
  });

  it('delivers on every open-file event, not just the first of the session', () => {
    const bridge = installBridge();
    const onFile = vi.fn();

    listenOpenFile(onFile);
    bridge.emitOpenFile(['/a.pdf']);
    bridge.emitOpenFile(['/b.pdf']);

    expect(onFile.mock.calls).toEqual([['/a.pdf'], ['/b.pdf']]);
  });

  it('does not deliver a drain that resolves after unsubscribe', async () => {
    let release: (value: { paths: string[] }) => void = () => {};
    const pending = new Promise<{ paths: string[] }>((resolve) => {
      release = resolve;
    });
    installBridge({ takeLaunchFiles: () => pending });
    const onFile = vi.fn();

    const unsubscribe = listenOpenFile(onFile);
    unsubscribe();
    release({ paths: ['/launch/PT99.pdf'] });
    await pending;

    expect(onFile).not.toHaveBeenCalled();
  });

  it('tolerates a rejected or malformed drain', async () => {
    const bridge = installBridge({ takeLaunchFiles: async () => Promise.reject(new Error('no channel')) });
    const onFile = vi.fn();

    listenOpenFile(onFile);
    await Promise.resolve();
    bridge.emitOpenFile([]);

    expect(onFile).not.toHaveBeenCalled();
  });

  it('is inert without the desktop bridge', () => {
    const onFile = vi.fn();
    expect(() => listenOpenFile(onFile)()).not.toThrow();
    expect(onFile).not.toHaveBeenCalled();
  });
});

describe('listenTrayNavigate', () => {
  it('navigates on the explicit deep link', () => {
    const bridge = installBridge();
    const onNavigate = vi.fn();

    listenTrayNavigate(onNavigate);
    bridge.emitSecondInstance(['/usr/bin/studyvault', 'studyvault://navigate/srs']);

    expect(onNavigate).toHaveBeenCalledWith('/srs');
  });

  it('ignores the Linux argv[0] executable path instead of treating it as a route', () => {
    const bridge = installBridge();
    const onNavigate = vi.fn();

    listenTrayNavigate(onNavigate);
    bridge.emitSecondInstance(['/usr/bin/studyvault']);
    bridge.emitSecondInstance(['/opt/StudyVault/studyvault', '/home/user/PT99.pdf']);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('rejects deep links whose route is not a plain in-app path', () => {
    const bridge = installBridge();
    const onNavigate = vi.fn();

    listenTrayNavigate(onNavigate);
    bridge.emitSecondInstance(['studyvault://navigate//evil.com']);
    bridge.emitSecondInstance(['studyvault://navigate/../../etc/passwd']);
    bridge.emitSecondInstance(['studyvault://navigate/https://evil.com']);
    bridge.emitSecondInstance(['studyvault://navigate/']);

    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('pickPdfFile', () => {
  it('reads the picked file into an importable File', async () => {
    installBridge({ picked: [{ path: '/picked/PT99.pdf', name: 'PT99.pdf', extension: '.pdf', size: 3 }] });

    const file = await pickPdfFile();

    expect(file?.name).toBe('PT99.pdf');
    expect(file?.type).toBe('application/pdf');
  });

  it('returns null when the dialog is cancelled', async () => {
    installBridge({ picked: [] });
    await expect(pickPdfFile()).resolves.toBeNull();
  });
});
