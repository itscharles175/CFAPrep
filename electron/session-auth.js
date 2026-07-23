export function isExactLsatApiUrl(input) {
  if (typeof input !== 'string' || !/^http:\/\/127\.0\.0\.1:8100\//.test(input)) return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === '8100' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

export function installLsatAuthorization(session, getToken) {
  const redirected = new Set();
  const filter = { urls: ['http://127.0.0.1:8100/*', 'http://*/*', 'https://*/*'] };

  session.webRequest.onBeforeRedirect(filter, (details) => {
    redirected.add(details.id);
  });
  session.webRequest.onCompleted(filter, (details) => {
    redirected.delete(details.id);
  });
  session.webRequest.onErrorOccurred(filter, (details) => {
    redirected.delete(details.id);
  });
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!redirected.has(details.id) && isExactLsatApiUrl(details.url)) {
      const token = getToken();
      if (/^[a-f0-9]{64}$/.test(token)) {
        const requestHeaders = { ...details.requestHeaders, Authorization: `Bearer ${token}` };
        callback({ requestHeaders });
        return;
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}
