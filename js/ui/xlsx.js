import { projectReport, money } from '../core/report.js';

const WIDTHS = { A: 7.5, B: 60, C: 19, D: 8, E: 8, F: 20, G: 11, H: 11, I: 11, J: 11, K: 7.5, L: 9, M: 12, N: 18 };
const THIN = { style: 'thin' };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD = ['№', 'Наименование', 'Артикул', 'Разм1', 'Разм2', 'Цвет', 'Доп1', 'Доп2', 'Доп3', 'Доп4', 'Ед Изм', 'Ко-во', 'Цена за единицу измерения', 'Цена'];
const LINE = '_'.repeat(150);
const toNum = (text) => { const n = Number(String(text).replace(',', '.')); return text !== '' && Number.isFinite(n) ? n : null; };

export function buildWorkbook(app) {
  const { db, project } = app;
  const report = projectReport(db, project);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('1', { pageSetup: { margins: { left: 0.66, right: 0.66, top: 0.74, bottom: 0.74, header: 0.3, footer: 0.3 } } });
  for (const [col, width] of Object.entries(WIDTHS)) ws.getColumn(col).width = width;
  let y = 3;

  const band = (from, to, text, { size = 12, bold = false, italic = false, align = 'left', border = false, color, height } = {}) => {
    if (from !== to) ws.mergeCells(`${from}${y}:${to}${y}`);
    const cell = ws.getCell(`${from}${y}`);
    cell.value = text;
    cell.font = { name: 'Times New Roman', size, bold, italic, color: color ? { argb: color } : undefined };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: border };
    if (border) {
      const a = from.charCodeAt(0);
      const b = to.charCodeAt(0);
      for (let c = a; c <= b; c++) ws.getCell(`${String.fromCharCode(c)}${y}`).border = BORDER;
    }
    if (height) ws.getRow(y).height = height;
    return cell;
  };

  band('A', 'N', `НОМЕР ДОГОВОРА: ${project.info.number ?? ''}`, { size: 14, bold: true, align: 'center' }); y++;
  for (const label of ['Адрес', 'Телефон', 'Контактное лицо', 'Менеджер компании ', `Дополнительно ___________${project.info.note ?? ''}`]) {
    band('A', 'N', label + LINE, { size: 14, bold: true, italic: true }); y++;
  }
  y++;
  band('A', 'N', 'Детали', { bold: true, align: 'center', height: 25 }); y++;
  HEAD.forEach((text, i) => band(String.fromCharCode(65 + i), String.fromCharCode(65 + i), text, { align: 'center', border: true }));
  y++;

  const detailRow = (cells, sub) => {
    const [num, name, art, s1, s2, color, unit, qty, price] = cells;
    const style = { size: sub ? 10 : 12, italic: sub, border: true };
    const q = toNum(qty);
    const p = toNum(price);
    band('A', 'A', num, { ...style, align: sub ? 'right' : 'center' });
    band('B', 'B', name, { ...style });
    band('C', 'C', art, { ...style });
    band('D', 'D', toNum(s1) ?? s1, { ...style, align: 'right' });
    band('E', 'E', toNum(s2) ?? s2, { ...style, align: 'right' });
    band('F', 'F', color, { ...style, align: 'center' });
    for (const c of 'GHIJ') band(c, c, '', style);
    band('K', 'K', unit, { ...style, align: 'center' });
    band('L', 'L', q ?? qty, { ...style, align: 'right' });
    band('M', 'M', q && p != null ? Math.round(p / q) : '', { ...style, align: 'right' });
    band('N', 'N', p ?? price, { ...style, align: 'right' }).numFmt = '0.00';
    y++;
  };
  const totalRow = (label, value, color) => {
    band('A', 'M', label, { bold: true, align: 'right', color });
    band('N', 'N', value, { bold: true, align: 'right', color });
    y += 2;
  };

  for (const block of report.blocks) {
    for (const row of block.rows) {
      if (row.type === 'sub' && row.cells[8] === '0,00') continue;
      detailRow(row.cells, row.type === 'sub');
    }
  }
  y++;
  for (const block of report.blocks) totalRow(`СТОИМОСТЬ МАТЕРИАЛА${report.blocks.length > 1 ? ` (изделие ${block.product.num}, ${block.product.title})` : ''}`, `${money(block.total)} руб.`);
  totalRow('ИТОГО: ', `${money(report.total)} руб.`, 'FFFF0000');
  return wb;
}

export async function exportReport(app, download) {
  if (!app.project.products.length) { app.toast('В проекте нет изделий'); return; }
  const wb = buildWorkbook(app);
  const data = await wb.xlsx.writeBuffer();
  const number = (app.project.info.number ?? '').trim();
  download(`${number ? number + ' - ' : ''}ДЕТАЛИРОВКА.xlsx`, new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
