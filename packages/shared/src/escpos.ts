/**
 * Minimal ESC/POS byte builder for 58/80mm thermal printers.
 * Produces a Uint8Array that can be sent raw to a network printer (port 9100), a USB
 * printer via a local print agent, or the browser via WebUSB/WebSerial.
 */
const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private bytes: number[] = [];
  constructor(private readonly width: number = 42) {
    this.bytes.push(ESC, 0x40); // init
  }

  private push(...b: number[]): this {
    this.bytes.push(...b);
    return this;
  }

  text(s: string): this {
    // Thermal printers usually lack ₹; caller should pass "Rs." where needed.
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      this.bytes.push(code < 256 ? code : 0x3f);
    }
    return this;
  }

  line(s = ''): this {
    return this.text(s).push(0x0a);
  }

  align(a: 'left' | 'center' | 'right'): this {
    return this.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  size(w: 1 | 2, h: 1 | 2): this {
    return this.push(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }

  rule(ch = '-'): this {
    return this.line(ch.repeat(this.width));
  }

  /** Two columns: left text, right text, padded to width. */
  row(left: string, right: string): this {
    const space = this.width - right.length;
    const l = left.length > space - 1 ? left.slice(0, space - 1) : left;
    return this.line(l.padEnd(space) + right);
  }

  /** Columns with fixed widths; last column right aligned. */
  cols(cells: string[], widths: number[]): this {
    let out = '';
    cells.forEach((c, i) => {
      const w = widths[i];
      const last = i === cells.length - 1;
      const t = c.length > w ? c.slice(0, w) : c;
      out += last ? t.padStart(w) : t.padEnd(w);
    });
    return this.line(out);
  }

  feed(n = 3): this {
    return this.push(ESC, 0x64, n);
  }

  cut(): this {
    return this.push(GS, 0x56, 0x42, 0x00);
  }

  openDrawer(): this {
    return this.push(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Convert a byte array to base64 (browser+node safe, no Buffer dependency). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
