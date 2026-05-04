export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        function notifyUpdateAvailable(worker) {
          window.dispatchEvent(
            new CustomEvent('quantvault:pwa-update', {
              detail: {
                applyUpdate: () => worker?.postMessage({ type: 'SKIP_WAITING' }),
              },
            }),
          );
        }

        if (registration.waiting) notifyUpdateAvailable(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              notifyUpdateAvailable(worker);
            }
          });
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'CACHE_VERSION') {
            window.dispatchEvent(new CustomEvent('quantvault:pwa-version', { detail: event.data.version }));
          }
        });

        navigator.serviceWorker.ready.then((readyRegistration) => {
          readyRegistration.active?.postMessage({ type: 'GET_VERSION' });
        });

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
      })
      .catch(() => {
        // Offline support is a progressive enhancement; the app remains usable without it.
      });
  });
}
