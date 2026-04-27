const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

// ルーム状態
function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],   // { id, name, seatIdx }
      started: false,
      turn: 0,
    };
  }
  return rooms[roomId];
}

// 4席の配列に変換（空席はnull）
function toSeats(room) {
  const seats = Array(4).fill(null);
  room.players.forEach(p => { seats[p.seatIdx] = p; });
  return seats;
}

io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  // ルーム参加
  socket.on("join-room", ({ roomId, name }) => {
    const room = getRoom(roomId);

    if (room.players.length >= 4) {
      socket.emit("room-full");
      return;
    }

    const seatIdx = room.players.length; // 入室順に席を確定
    const player = { id: socket.id, name, seatIdx };
    room.players.push(player);
    socket.join(roomId);
    // socketにroomIdを紐付け（切断時に使う）
    socket.data.roomId = roomId;

    // 全員に席情報を送信
    io.to(roomId).emit("room-update", toSeats(room));
  });

  // ゲーム開始
  socket.on("start-game", ({ roomId, names, slotTypes }) => {
    const room = getRoom(roomId);
    room.started = true;
    room.turn = 0;

    // CPUスロット情報を反映
    if (names && slotTypes) {
      for (let i = 0; i < 4; i++) {
        if (slotTypes[i] === 'cpu') {
          // CPU席はサーバー管理外だが名前だけ保持
          room.cpuSlots = room.cpuSlots || {};
          room.cpuSlots[i] = { name: names[i] };
        }
      }
    }

    // playersリストを4席分に拡張（CPU含む）
    const seats = toSeats(room);
    const fullPlayers = seats.map((p, i) => {
      if (p) return p;
      if (names && slotTypes && slotTypes[i] === 'cpu') return { id: `cpu_${i}`, name: names[i], seatIdx: i };
      return null;
    });

    io.to(roomId).emit("game-start", {
      players: fullPlayers,
      turn: room.turn,
    });
  });

  // 捨て牌など同期
  socket.on("game-action", ({ roomId, data }) => {
    const room = getRoom(roomId);

    // ターン更新
    if (data.type === "discard") {
      room.turn = (room.turn + 1) % 4;
    }

    // 送信元IDを付けて全員にブロードキャスト
    io.to(roomId).emit("game-action", {
      ...data,
      from: socket.id,
      turn: room.turn,
    });
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      io.to(roomId).emit("room-update", toSeats(room));
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`サーバー起動 port:${PORT}`);
});
