// Gera os ícones PNG da extensão (16, 32, 48 e 128 px) sem dependências.
// Uso: node ferramentas/gerar-icones.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const pasta = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extensao', 'icones');

const TABELA_CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloco(tipo, dados) {
  const t = Buffer.from(tipo, 'ascii');
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([tam, t, dados, crc]);
}

function png(lado, rgba) {
  const linhas = Buffer.alloc((lado * 4 + 1) * lado);
  for (let y = 0; y < lado; y++) {
    linhas[y * (lado * 4 + 1)] = 0;
    rgba.copy(linhas, y * (lado * 4 + 1) + 1, y * lado * 4, (y + 1) * lado * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

// Formas num quadrado de 0 a 1.
function dentroDoFundo(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function dentroDaPonte(x, y) {
  // arco
  const cx = 0.5;
  const cy = 0.72;
  const d = Math.hypot(x - cx, y - cy);
  const arco = y <= cy && d >= 0.27 && d <= 0.37;
  // tabuleiro
  const tabuleiro = y >= 0.6 && y <= 0.69 && x >= 0.1 && x <= 0.9;
  // pilares
  const pilar = y >= 0.6 && y <= 0.84 && ((x >= 0.17 && x <= 0.25) || (x >= 0.75 && x <= 0.83));
  // tirantes entre o arco e o tabuleiro
  const tirante = y >= 0.42 && y <= 0.6 && [0.38, 0.5, 0.62].some((t) => Math.abs(x - t) <= 0.022) && d <= 0.33;
  return arco || tabuleiro || pilar || tirante;
}

function desenhar(lado) {
  const amostras = 6;
  const rgba = Buffer.alloc(lado * lado * 4);
  for (let py = 0; py < lado; py++) {
    for (let px = 0; px < lado; px++) {
      let fundo = 0;
      let ponte = 0;
      for (let sy = 0; sy < amostras; sy++) {
        for (let sx = 0; sx < amostras; sx++) {
          const x = (px + (sx + 0.5) / amostras) / lado;
          const y = (py + (sy + 0.5) / amostras) / lado;
          if (dentroDoFundo(x, y)) {
            fundo++;
            if (dentroDaPonte(x, y)) ponte++;
          }
        }
      }
      const total = amostras * amostras;
      const a = fundo / total;
      const p = fundo ? ponte / fundo : 0;
      // degradê azul de cima para baixo
      const t = py / (lado - 1);
      const r0 = Math.round(0x4a + (0x2c - 0x4a) * t);
      const g0 = Math.round(0x6c + (0x4a - 0x6c) * t);
      const b0 = Math.round(0xf2 + (0xc8 - 0xf2) * t);
      const i = (py * lado + px) * 4;
      rgba[i] = Math.round(r0 + (255 - r0) * p);
      rgba[i + 1] = Math.round(g0 + (255 - g0) * p);
      rgba[i + 2] = Math.round(b0 + (255 - b0) * p);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return png(lado, rgba);
}

fs.mkdirSync(pasta, { recursive: true });
for (const lado of [16, 32, 48, 128]) {
  const arquivo = path.join(pasta, `icone-${lado}.png`);
  fs.writeFileSync(arquivo, desenhar(lado));
  console.log('gerado', path.relative(process.cwd(), arquivo));
}
