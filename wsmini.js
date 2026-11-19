// 极简 WebSocket 服务器 (RFC6455), 接口与 ws 库兼容本项目用到的部分
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class MiniWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1;
    this._buf = Buffer.alloc(0);
    this._frags = [];
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }
  _onClose() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);
    while (true) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this._buf.length < 4) return; len = this._buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this._buf.length < 10) return; len = Number(this._buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { if (this._buf.length < off + 4) return; maskKey = this._buf.slice(off, off + 4); off += 4; }
      if (this._buf.length < off + len) return;
      let payload = this._buf.slice(off, off + len);
      if (masked) { const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= maskKey[i % 4]; payload = p; }
      this._buf = this._buf.slice(off + len);
      if (op === 8) { this.sendFrame(8, Buffer.alloc(0)); try { this.socket.end(); } catch {} this._onClose(); return; }
      if (op === 9) { this.sendFrame(10, payload); continue; }
      if (op === 10) continue;
      this._frags.push(payload);
      if (fin) {
        const msg = Buffer.concat(this._frags).toString('utf8');
        this._frags = [];
        this.emit('message', msg);
      }
    }
  }
  sendFrame(op, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch {}
  }
  send(str) { if (this.readyState === 1) this.sendFrame(1, Buffer.from(String(str), 'utf8')); }
}

class MiniWSServer extends EventEmitter {
  constructor({ server }) {
    super();
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      this.emit('connection', new MiniWebSocket(socket));
    });
  }
}

module.exports = { WebSocketServer: MiniWSServer };
