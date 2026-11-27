import qrcode from "qrcode-generator";

/** A QR code's grid: its width in modules, which are dark, and the dark ones as one SVG path. */
export interface QrModules {
  size: number;
  dark: (row: number, col: number) => boolean;
  path: string;
}

/** Encodes text at error-correction level M, in the smallest version that fits. */
export function qrModules(text: string): QrModules {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (row: number, col: number) => qr.isDark(row, col);
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (dark(row, col)) path += `M${col} ${row}h1v1h-1z`;
  }
  return { size, dark, path };
}
