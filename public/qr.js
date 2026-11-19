// Generador QR Code (ISO/IEC 18004, Modelo 2, Byte mode, Corrección de error M, Versiones 1..10) -> SVG local.
// Cero dependencias externas, cero llamadas de red, 100% compatible con CSP estricta (default-src 'self').

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerador(grado) {
  let poly = [1];
  for (let i = 0; i < grado; i++) {
    const sig = new Array(poly.length + 1).fill(0);
    const raiz = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      sig[j] ^= poly[j];
      sig[j + 1] ^= gfMul(poly[j], raiz);
    }
    poly = sig;
  }
  return poly;
}

function rsResto(datos, ecLen) {
  const gen = rsGenerador(ecLen);
  const res = new Uint8Array(ecLen);
  for (let i = 0; i < datos.length; i++) {
    const factor = datos[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

// Tabla ISO/IEC 18004 para Nivel M (15% corrección), Versiones 1..10: [totalDataBytes, ecPerBlock, [[numBlocks, dataPerBlock], ...], alignmentCenters]
const VERSIONES_M = [
  null,
  [16, 10, [[1, 16]], []],
  [28, 16, [[1, 28]], [6, 18]],
  [44, 26, [[1, 44]], [6, 22]],
  [64, 18, [[2, 32]], [6, 26]],
  [86, 24, [[2, 43]], [6, 30]],
  [108, 16, [[4, 27]], [6, 34]],
  [124, 18, [[4, 31]], [6, 22, 38]],
  [154, 22, [[2, 38], [2, 39]], [6, 24, 42]],
  [182, 22, [[3, 36], [2, 37]], [6, 26, 46]],
  [216, 26, [[4, 43], [1, 44]], [6, 28, 50]],
];

const INFO_VERSION = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

function calcularInfoFormato(mask) {
  // ECC Level M = 0b00 -> 5 bits: (0 << 3) | mask
  const data = mask & 7;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function elegirVersion(lenBytes) {
  for (let v = 1; v < VERSIONES_M.length; v++) {
    const capBits = VERSIONES_M[v][0] * 8;
    const ccBits = v < 10 ? 8 : 16;
    if (4 + ccBits + lenBytes * 8 <= capBits) return v;
  }
  throw new Error("Texto demasiado largo para código QR (máximo 213 bytes).");
}

function construirFlujoDatos(bytes, version) {
  const [totalData, ecLen, grupos] = VERSIONES_M[version];
  const bits = [];
  const pushBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Modo Byte
  pushBits(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  // Terminador (hasta 4 ceros)
  const maxBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }
  const pads = [0xec, 0x11];
  for (let p = 0; dataBytes.length < totalData; p++) dataBytes.push(pads[p & 1]);

  // Dividir en bloques RS e intercalar
  const bloquesData = [];
  const bloquesEc = [];
  let off = 0;
  for (const [nBloques, dLen] of grupos) {
    for (let i = 0; i < nBloques; i++) {
      const trozo = Uint8Array.from(dataBytes.slice(off, off + dLen));
      off += dLen;
      bloquesData.push(trozo);
      bloquesEc.push(rsResto(trozo, ecLen));
    }
  }

  const finalBytes = [];
  const maxD = Math.max(...bloquesData.map((b) => b.length));
  for (let i = 0; i < maxD; i++) {
    for (const b of bloquesData) if (i < b.length) finalBytes.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of bloquesEc) finalBytes.push(b[i]);
  }
  return finalBytes;
}

function crearMatrizBase(version) {
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Uint8Array(size));
  const func = Array.from({ length: size }, () => new Uint8Array(size));
  const setF = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = v ? 1 : 0;
    func[r][c] = 1;
  };

  // Patrones buscadores (3 esquinas) + separadores
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        setF(r, c, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Patrones de alineación
  const centros = VERSIONES_M[version][3];
  for (const r of centros) {
    for (const c of centros) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setF(r + dr, c + dc, dist !== 1);
        }
      }
    }
  }

  // Patrones de temporización
  for (let i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0);
    setF(i, 6, i % 2 === 0);
  }

  // Reservar áreas de formato y módulo oscuro fijo
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setF(8, i, 0);
      setF(i, 8, 0);
    }
  }
  for (let i = 0; i < 8; i++) {
    setF(8, size - 1 - i, 0);
    setF(size - 1 - i, 8, 0);
  }
  setF(size - 8, 8, 1);

  // Información de versión (versiones >= 7)
  if (version >= 7) {
    const info = INFO_VERSION[version];
    for (let i = 0; i < 18; i++) {
      const bit = (info >>> i) & 1;
      const a = Math.floor(i / 3), b = size - 11 + (i % 3);
      setF(a, b, bit);
      setF(b, a, bit);
    }
  }

  return { size, mod, func };
}

function escribirFormato(mod, size, mask) {
  const bits = calcularInfoFormato(mask);
  const bit = (i) => (bits >>> i) & 1;
  // Alrededor de esquina superior izquierda
  const coordsA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = coordsA[i];
    mod[r][c] = bit(14 - i);
  }
  // Esquinas inferior izquierda y superior derecha
  for (let i = 0; i < 7; i++) mod[size - 1 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) mod[8][size - 8 + i] = bit(7 - i);
}

function colocarDatos(mod, func, size, codewords) {
  let idxBit = 0;
  const totalBits = codewords.length * 8;
  let subiendo = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let paso = 0; paso < size; paso++) {
      const r = subiendo ? size - 1 - paso : paso;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (func[r][c]) continue;
        let bit = 0;
        if (idxBit < totalBits) {
          bit = (codewords[idxBit >>> 3] >>> (7 - (idxBit & 7))) & 1;
          idxBit++;
        }
        mod[r][c] = bit;
      }
    }
    subiendo = !subiendo;
  }
}

const MASCARAS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalizacion(mod, size) {
  let score = 0;
  // N1: corridas horizontales y verticales >= 5
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (mod[r][c] === mod[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (mod[r][c] === mod[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  // N2: bloques 2x2 del mismo color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
    }
  }
  // N4: balance oscuro/claro
  let oscuros = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mod[r][c]) oscuros++;
  const porc = (oscuros * 100) / (size * size);
  score += Math.floor(Math.abs(porc - 50) / 5) * 10;
  return score;
}

export function generarMatrizQr(texto) {
  const bytes = new TextEncoder().encode(String(texto ?? ""));
  const version = elegirVersion(bytes.length);
  const codewords = construirFlujoDatos(bytes, version);
  const { size, mod: base, func } = crearMatrizBase(version);
  colocarDatos(base, func, size, codewords);

  let mejorMask = 0;
  let mejorScore = Infinity;
  let mejorMod = null;

  for (let m = 0; m < 8; m++) {
    const copia = base.map((fila) => Uint8Array.from(fila));
    const fn = MASCARAS[m];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!func[r][c] && fn(r, c)) copia[r][c] ^= 1;
      }
    }
    escribirFormato(copia, size, m);
    const sc = penalizacion(copia, size);
    if (sc < mejorScore) {
      mejorScore = sc;
      mejorMask = m;
      mejorMod = copia;
    }
  }
  return { version, size, mask: mejorMask, matriz: mejorMod };
}

export function generarQrSvg(texto, { tamPx = 220, margen = 4 } = {}) {
  const { size, matriz } = generarMatrizQr(texto);
  const total = size + margen * 2;
  const cmds = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matriz[r][c]) cmds.push(`M${c + margen},${r + margen}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${tamPx}" height="${tamPx}" role="img" aria-label="Código QR de verificación 2FA" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${cmds.join("")}" fill="#111827"/></svg>`;
}
