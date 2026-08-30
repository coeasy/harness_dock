const invoke = window.__TAURI__?.core?.invoke;
const $ = (id) => document.getElementById(id);
const status = $('status');
const detail = $('detail');
let profile = null;

function setStatus(text, info = '', bad = false) {
  status.textContent = text;
  status.style.color = bad ? '#fca5a5' : '#5eead4';
  detail.textContent = info;
}

async function call(command, args = {}) {
  if (!invoke) throw new Error('Tauri IPC unavailable');
  return invoke(command, args);
}

async function init() {
  try {
    profile = await call('platform_profile');
    $('platform').textContent = `${profile.os} / ${profile.arch}${profile.mobile ? ' · Mobile' : ' · Desktop'}`;
    if (!profile.mobile) $('desktop-card').classList.remove('hidden');
    const saved = await call('load_connection');
    if (saved?.gateway_url) $('gateway').value = saved.gateway_url;
  } catch (error) {
    setStatus('初始化失败', String(error), true);
  }
}

$('probe').addEventListener('click', async () => {
  const url = $('gateway').value.trim();
  if (!url) return setStatus('请输入 Gateway 地址', '', true);
  setStatus('检测中…');
  try {
    const result = await call('gateway_probe', { url });
    setStatus(result.ok ? 'Gateway 可用' : 'Gateway 不可用', result.message || '', !result.ok);
  } catch (error) {
    setStatus('Gateway 不可用', String(error), true);
  }
});

$('connect').addEventListener('click', async () => {
  const gatewayUrl = $('gateway').value.trim();
  const credential = $('pairing').value.trim();
  if (!gatewayUrl) return setStatus('请输入 Gateway 地址', '', true);
  setStatus('正在建立会话…');
  try {
    const result = await call('connect_gateway', { gatewayUrl, credential });
    setStatus('连接成功', '正在进入 Harness Web UI…');
    window.location.replace(result.web_url);
  } catch (error) {
    setStatus('连接失败', String(error), true);
  }
});

$('start-local').addEventListener('click', async () => {
  setStatus('正在启动本地 Runtime…');
  try {
    const result = await call('launch_local_runtime');
    setStatus('Runtime 已启动', `pid=${result.pid}\n${result.web_url}`);
    window.location.replace(result.web_url);
  } catch (error) {
    setStatus('Runtime 启动失败', String(error), true);
  }
});

void init();
