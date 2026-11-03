// Mã hóa Code 128 (bộ B: chữ, số, ký tự ASCII in được) cho tem hàng và hóa đơn.

export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212',
  '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321',
  '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

/** Trả về chuỗi module: mỗi phần tử true là vạch đen, false là khoảng trắng. */
export function code128Modules(text) {
  const values = [START_B];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 32 || code > 127) throw new Error('Mã vạch chỉ được chứa ký tự không dấu');
    values.push(code - 32);
  }
  const checksum = values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
  values.push(checksum, STOP);
  const modules = [];
  for (const v of values) {
    let black = true;
    for (const w of CODE128_PATTERNS[v]) {
      for (let i = 0; i < Number(w); i += 1) modules.push(black);
      black = !black;
    }
  }
  return modules;
}

export function code128Svg(text, { height = 40, moduleWidth = 1 } = {}) {
  const modules = code128Modules(text);
  let bars = '';
  for (let i = 0; i < modules.length; i += 1) {
    if (!modules[i]) continue;
    let run = 1;
    while (modules[i + run]) run += 1;
    bars += `<rect x="${i * moduleWidth}" y="0" width="${run * moduleWidth}" height="${height}"/>`;
    i += run - 1;
  }
  const width = modules.length * moduleWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges">${bars}</svg>`;
}
