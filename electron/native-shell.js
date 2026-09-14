export const NATIVE_ROUTES = Object.freeze({
  today: '/__native/workspace/today',
  learn: '/__native/workspace/learn',
  practice: '/__native/workspace/practice',
  review: '/__native/workspace/review',
  progress: '/__native/workspace/progress',
  library: '/__native/workspace/library',
  settings: '/preferences',
  diagnostics: '/system',
  resume: '/__native/resume',
});

const goItems = [
  ['Today', '1', NATIVE_ROUTES.today],
  ['Learn', '2', NATIVE_ROUTES.learn],
  ['Practice', '3', NATIVE_ROUTES.practice],
  ['Review', '4', NATIVE_ROUTES.review],
  ['Progress', '5', NATIVE_ROUTES.progress],
  ['Library', '6', NATIVE_ROUTES.library],
];

export function buildMacMenuTemplate({
  navigate,
  openDocument,
  toggleSidebar,
  development = false,
  platform = process.platform,
}) {
  const template = [
    {
      label: 'StudyVault',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => navigate(NATIVE_ROUTES.settings, 'menu') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Study Document…', accelerator: 'CommandOrControl+O', click: openDocument },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: goItems.map(([label, key, route]) => ({
        label,
        accelerator: `CommandOrControl+${key}`,
        click: () => navigate(route, 'menu'),
      })),
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CommandOrControl+Shift+S', click: toggleSidebar },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(development
          ? [{ type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
          : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Diagnostics', click: () => navigate(NATIVE_ROUTES.diagnostics, 'menu') }],
    },
  ];
  if (platform !== 'darwin') template.shift();
  return template;
}

export function installNativeMenus({ app, Menu, navigate, openDocument, toggleSidebar, development = false }) {
  const applicationMenu = Menu.buildFromTemplate(
    buildMacMenuTemplate({ app, navigate, openDocument, toggleSidebar, development }),
  );
  Menu.setApplicationMenu(applicationMenu);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'Today', click: () => navigate(NATIVE_ROUTES.today, 'dock') },
        { label: 'Resume Study', click: () => navigate(NATIVE_ROUTES.resume, 'dock') },
        { label: 'Review', click: () => navigate(NATIVE_ROUTES.review, 'dock') },
      ]),
    );
  }
  return applicationMenu;
}

export function nativeRouteFromDeepLink(link) {
  if (!link || typeof link.route !== 'string') return null;
  if (link.action === 'route' || link.action === 'open') return link.route || '/';
  return null;
}
