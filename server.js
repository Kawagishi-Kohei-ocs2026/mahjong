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
      players: [],
      started: false,
      turn: 0,
    };
  }
  return rooms[roomId];
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

    const player = {
      id: socket.id,
      name,
    };

    room.players.push(player);
    socket.join(roomId);

    io.to(roomId).emit("room-update", room.players);
  });

  // ゲーム開始
  socket.on("start-game", (roomId) => {
    const room = getRoom(roomId);
    room.started = true;
    room.turn = 0;

    io.to(roomId).emit("game-start", {
      players: room.players,
      turn: room.turn,
    });
  });

  // 捨て牌など同期
  socket.on("game-action", ({ roomId, data }) => {
    const room = getRoom(roomId);

    // ターン更新（超シンプル版）
    if (data.type === "discard") {
      room.turn = (room.turn + 1) % 4;
    }

    io.to(roomId).emit("game-action", {
      ...data,
      turn: room.turn,
    });
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("サーバー起動");
});