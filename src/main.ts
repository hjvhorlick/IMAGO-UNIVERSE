/**
 * IMAGO UNIVERSE - entry point.
 * Create worlds. Bring them to life.
 */
import './styles/app.css';
import { App } from './ui/app';
import { el, qs } from './ui/dom';

async function boot() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app root is missing');
  const app = new App();
  try {
    await app.mount(root);
    (window as unknown as { imago: App }).imago = app;
  } catch (err) {
    const error = err as Error;
    console.error('[imago] startup failed', error);
    root.innerHTML = '';
    root.appendChild(el(`<div class="loading-screen"><div class="loading-inner" style="max-width:520px">
      <div class="loading-mark" style="background:linear-gradient(120deg,#f87171,#fbbf24)"></div>
      <div style="font-size:16px;font-weight:650">Imago Universe could not start</div>
      <div style="font-size:12px;color:#9aa7bd;margin-top:12px;line-height:1.6">${error.message}</div>
      <div style="font-size:11px;color:#6b788f;margin-top:16px;line-height:1.6">
        The artwork library is served from <code>public/library</code>. If you opened this file directly,
        run <code>npm run dev</code> instead - the app needs to be served over HTTP so it can load its assets.
      </div>
    </div></div>`));
    qs('.loading-screen', root)?.classList.add('error');
  }
}

void boot();
