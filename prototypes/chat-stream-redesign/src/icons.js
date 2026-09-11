/* 图标:统一 24 栅格 / 1.8 描边 / currentColor —— 与产品一致用描边风格。 */
const I = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  /* ── 工具类 ── */
  read: I(`<path d="M5 4.5h9.5L19 9v10.5H5z"/><path d="M14 4.5V9h4.5M8 13h8M8 16.5h5"/>`),
  edit: I(`<path d="M4.5 19.5l4.2-1L19 8.2a2 2 0 0 0-2.8-2.8L5.5 15.6z"/><path d="M15.6 6.4l2.8 2.8"/>`),
  write: I(`<path d="M5 4.5h9.5L19 9v10.5H5z"/><path d="M14 4.5V9h4.5M12 11.5v6M9 14.5h6"/>`),
  terminal: I(`<rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="M7.5 10.5l2.5 2.5-2.5 2.5M13 15h4"/>`),
  search: I(`<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/>`),
  glob: I(`<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.5 2.4 13.9 0 16.4-2.4-2.5-2.4-13.9 0-16.4z"/>`),
  task: I(`<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><circle cx="9" cy="11" r="1.8"/><path d="M5.8 16.4c.7-1.5 1.9-2.2 3.2-2.2s2.5.7 3.2 2.2M15.5 10h3M15.5 13.5h3"/>`),
  list: I(`<path d="M4 7h16M4 12h11M4 17h7"/>`),
  ask: I(`<circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.5M12 16.6h.01"/>`),
  think: I(`<path d="M12 3.6 13.6 8.9 18.9 10.5 13.6 12.1 12 17.4 10.4 12.1 5.1 10.5 10.4 8.9z"/><path d="M18.6 16.2l.5 1.6 1.6.5-1.6.5-.5 1.6-.5-1.6-1.6-.5 1.6-.5z"/>`),
  skill: I(`<path d="M12 4.2 14 9l4.8 2-4.8 2-2 4.8L10 13l-4.8-2L10 9z"/><path d="M6 17.5l1 2.5 2.5 1"/>`),

  /* ── 动作类 ── */
  copy: I(`<rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 9V6.4A2.4 2.4 0 0 0 12.6 4H6.4A2.4 2.4 0 0 0 4 6.4v6.2A2.4 2.4 0 0 0 6.4 15H9"/>`),
  check: I(`<path d="M5 12.8l4.6 4.6L19 6.6"/>`),
  pencil: I(`<path d="M4.5 19.5l4.2-1L19 8.2a2 2 0 0 0-2.8-2.8L5.5 15.6z"/>`),
  rewind: I(`<path d="M4 10.5h9.5a5 5 0 0 1 0 10H8"/><path d="M7.5 6.5 4 10.5l3.5 4"/>`),
  bookmark: I(`<path d="M6.5 4.5h11v15l-5.5-4-5.5 4z"/>`),
  chevD: I(`<path d="M6 9.5l6 6 6-6"/>`),
  chevR: I(`<path d="M9.5 6l6 6-6 6"/>`),
  x: I(`<path d="M6 6l12 12M18 6L6 18"/>`),
  clock: I(`<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/>`),
  alert: I(`<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.6h.01"/>`),
  arrowR: I(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  fork: I(`<circle cx="7" cy="5.6" r="2.2"/><circle cx="7" cy="18.4" r="2.2"/><circle cx="17" cy="9.6" r="2.2"/><path d="M7 7.8v8.4M17 11.8c0 2.8-3 3-5 3.4"/>`),
  folder: I(`<path d="M4 7.4A2 2 0 0 1 6 5.4h3.6l1.8 2.2H18a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>`),
  file: I(`<path d="M6 4.5h8L18 8.5v11H6z"/><path d="M13.5 4.5V9H18"/>`),
  link: I(`<path d="M10 14a3.6 3.6 0 0 1 0-5l2-2a3.6 3.6 0 0 1 5 5l-1 1"/><path d="M14 10a3.6 3.6 0 0 1 0 5l-2 2a3.6 3.6 0 0 1-5-5l1-1"/>`),
  plus: I(`<path d="M12 5.5v13M5.5 12h13"/>`),
  send: I(`<path d="M5 12h13M12.5 6.5 19 12l-6.5 5.5"/>`),
  spark: I(`<path d="M12 4.5 13.4 9l4.5 1.4-4.5 1.4L12 16.3l-1.4-4.5L6.1 10.4 10.6 9z"/>`),
  layers: I(`<path d="M12 4 20 8.4 12 12.8 4 8.4z"/><path d="M4 12.6 12 17l8-4.4M4 16.4 12 20.8l8-4.4"/>`),
};

/** 取图标(带尺寸)。 */
export const ico = (name, size) => {
  const s = ICONS[name] || ICONS.file;
  return size ? s.replace('width="16" height="16"', `width="${size}" height="${size}"`) : s;
};
