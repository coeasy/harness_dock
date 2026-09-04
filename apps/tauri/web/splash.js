window.__harnessDockSetStatus = (value) => {
  const element = document.getElementById('splash-status')
  if (element) element.textContent = String(value || '正在执行…')
}
