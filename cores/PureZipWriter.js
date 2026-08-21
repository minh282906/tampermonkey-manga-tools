// core/PureZipWriter.js
(function(global) {
  'use strict';

  class PureZipWriter {
    constructor() { this.files = []; }
    addFile(filename, uint8Array) { this.files.push({ name: filename, data: uint8Array }); }
    
    static crc32(data) {
      let crc = -1;
      for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ PureZipWriter.crcTable[(crc ^ data[i]) & 0xFF];
      }
      return (crc ^ -1) >>> 0;
    }

    generateBlob() {
      const parts = [], centralEntries = [];
      let offset = 0;
      const enc = new TextEncoder();
      for (const file of this.files) {
        const nameBytes = enc.encode(file.name);
        const dataBytes = file.data;
        const crc = PureZipWriter.crc32(dataBytes);
        const size = dataBytes.length;

        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);
        view.setUint32(22, size, true);
        view.setUint16(26, nameBytes.length, true);
        header.set(nameBytes, 30);
        parts.push(header, dataBytes);

        const cent = new Uint8Array(46 + nameBytes.length);
        const cview = new DataView(cent.buffer);
        cview.setUint32(0, 0x02014b50, true);
        cview.setUint16(4, 20, true);
        cview.setUint16(6, 20, true);
        cview.setUint32(16, crc, true);
        cview.setUint32(20, size, true);
        cview.setUint32(24, size, true);
        cview.setUint16(28, nameBytes.length, true);
        cview.setUint32(42, offset, true);
        cent.set(nameBytes, 46);
        centralEntries.push(cent);
        offset += header.length + size;
      }
      let centralSize = 0;
      for (const cent of centralEntries) { parts.push(cent); centralSize += cent.length; }
      const eocd = new Uint8Array(22);
      const eview = new DataView(eocd.buffer);
      eview.setUint32(0, 0x06054b50, true);
      eview.setUint16(8, this.files.length, true);
      eview.setUint16(10, this.files.length, true);
      eview.setUint32(12, centralSize, true);
      eview.setUint32(16, offset, true);
      parts.push(eocd);
      return new Blob(parts, { type: 'application/zip' });
    }

    // TÍCH HỢP HÀM TẢI FILE TỰ ĐỘNG (DÙNG CHUNG CHO MỌI WEB)
    download(fileName) {
      const blob = this.generateBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = "noopener";
      a.style.display = "none";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  PureZipWriter.crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    PureZipWriter.crcTable[i] = c;
  }

  (typeof globalThis !== 'undefined' ? globalThis : window).PureZipWriter = PureZipWriter;
})(typeof window !== 'undefined' ? window : this);