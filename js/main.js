import dbData from '../data/db.json';
import { catalog, doors } from '../data/catalog.json';
import { Db } from './core/db.js';
import { App } from './ui/app.js';
import { Viewport } from './ui/viewport.js';
import { Panels } from './ui/panels.js';
import { bindCommands } from './ui/commands.js';
import { loadOfflineTextures } from './ui/texture-source.js';

async function boot() {
  await loadOfflineTextures();
  const app = new App(new Db(dbData), catalog, doors);
  app.loadSaved();
  const viewport = new Viewport(app, document.getElementById('viewport'));
  const panels = new Panels(app);
  bindCommands(app, viewport, panels);
  window.np = { app, viewport };
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('viewport').textContent = 'Не удалось запустить 3D-редактор: ' + e.message;
});
