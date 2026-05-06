self.onmessage = (event) => {
  try {
    self.postMessage({ ok: true, payload: JSON.parse(event.data.text) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to parse JSON file.',
    });
  }
};
