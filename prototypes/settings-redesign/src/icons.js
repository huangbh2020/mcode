/* 图标:统一 24 栅格 / 1.8 描边 / currentColor。与产品一致用描边风格,不用 emoji。 */
const I = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  sliders: I(`<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>`),
  palette: I(`<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>`),
  robot: I(`<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V5M8.5 5h7"/><circle cx="9.5" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1.1" fill="currentColor" stroke="none"/>`),
  box: I(`<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z"/><path d="M4 7.6 12 12l8-4.4M12 12v8.8"/>`),
  grid: I(`<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>`),
  sparkles: I(`<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z"/><path d="M18.5 16.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z"/>`),
  plug: I(`<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 17v4"/>`),
  mic: I(`<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>`),
  keyboard: I(`<rect x="3" y="7" width="18" height="11" rx="2.5"/><path d="M7 11h.01M10.5 11h.01M14 11h.01M17 11h.01M8 14.5h8"/>`),
  hand: I(`<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11V5a1.5 1.5 0 0 1 3 0v6-1.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 14.5V12a1.5 1.5 0 0 1 3 0"/>`),
  bell: I(`<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9"/><path d="M10 18a2 2 0 0 0 4 0"/>`),
  git: I(`<circle cx="7" cy="6" r="2.4"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="10" r="2.4"/><path d="M7 8.4v7.2M17 12.4c0 3-3 3.2-5 3.6"/>`),
  terminal: I(`<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7.5 10l2.5 2.5-2.5 2.5M13 15h4"/>`),
  globe: I(`<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17-2.5-2.6-2.5-14.4 0-17z"/>`),
  code: I(`<path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5M13.5 5l-3 14"/>`),
  chart: I(`<path d="M4 20h16"/><path d="M7 20V11M12 20V5M17 20v-6"/>`),
  info: I(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8.2h.01"/>`),
  search: I(`<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>`),
  chevR: I(`<path d="M9.5 6l6 6-6 6"/>`),
  chevD: I(`<path d="M6 9.5l6 6 6-6"/>`),
  plus: I(`<path d="M12 5v14M5 12h14"/>`),
  trash: I(`<path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>`),
  refresh: I(`<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V9h-4.5"/>`),
  download: I(`<path d="M12 4v10M8 10.5l4 4 4-4M5 19h14"/>`),
  folder: I(`<path d="M4 7.5A2 2 0 0 1 6 5.5h3.6l1.8 2.2H18a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>`),
  folderOpen: I(`<path d="M4 8V7a2 2 0 0 1 2-2h3.6l1.8 2.2H18a2 2 0 0 1 2 2V10"/><path d="M3 11h18l-2 8H5z"/>`),
  copy: I(`<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15"/>`),
  check: I(`<path d="M5 12.5l4.5 4.5L19 7"/>`),
  x: I(`<path d="M6 6l12 12M18 6L6 18"/>`),
  alert: I(`<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>`),
  ext: I(`<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>`),
  fileImport: I(`<path d="M13 4H7.5A1.5 1.5 0 0 0 6 5.5v13A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 4v5h5"/><path d="M12 11.5v5M9.8 14.4l2.2 2.2 2.2-2.2"/>`),
  stop: I(`<rect x="6" y="6" width="12" height="12" rx="2.5"/>`),
  pencil: I(`<path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.6-3.6L4.5 16.3z"/><path d="M14.5 7.5l2 2"/>`),
  eye: I(`<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>`),
  layers: I(`<path d="M12 3.5 20.5 8 12 12.5 3.5 8z"/><path d="M4 12.5 12 16.8l8-4.3M4 16.5 12 20.8l8-4.3"/>`),
  pin: I(`<path d="M9 4h6l-.8 5.2 2.8 2.4H5l2.8-2.4z"/><path d="M12 11.6V20"/>`),
  filter: I(`<path d="M4 6h16M7 12h10M10 18h4"/>`),
  key: I(`<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5 19 4M16 4h3v3"/>`),
  shield: I(`<path d="M12 3.5 19 6v6c0 4.2-3 7.2-7 8.5-4-1.3-7-4.3-7-8.5V6z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/>`),
  palette2: I(`<path d="M4.5 20.5l1-4 9-9a2.6 2.6 0 0 1 3.7 3.7l-9 9z"/><path d="M12 8.5 15.5 12"/>`),
  list: I(`<path d="M4 7h16M4 12h16M4 17h10"/>`),
  arrowRight: I(`<path d="M5 12h13M13 7l5 5-5 5"/>`),
  folderMove: I(`<path d="M4 8V7a2 2 0 0 1 2-2h3.5l1.7 2H18a2 2 0 0 1 2 2v3"/><path d="M3 13h18l-2 6.5H5z"/><path d="M9 17.5h6"/>`),
};

/** 取图标 inner svg;size 为可选像素尺寸覆盖 */
export function ico(name, size) {
  const s = ICONS[name] || ICONS.sliders;
  return size ? s.replace('width="16" height="16"', `width="${size}" height="${size}"`) : s;
}
