const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/* ===============================
   ルーム管理
================================= */

const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      started: false,
      turn: 0,
      deck: [],
      hands: [[], [], [], []],
      discards: [[], [], [], []],
      dora: [],
      uraDoraHidden: [],
      scores: [25000, 25000, 25000, 25000],
      dealerIdx: 0,
      roundNum: 0,
      honba: 0,
    };
  }
  return rooms[roomId];
}

function toSeats(room) {
  const seats = Array(4).fill(null);
  room.players.forEach(p => {
    seats[p.seatIdx] = p;
  });
  return seats;
}

/* ===============================
   山生成
================================= */

function buildDeck() {
  const d = [];
  for (const suit of ['man', 'pin', 'sou']) {
    for (let n = 0; n < 9; n++)
      for (let c = 0; c < 4; c++)
        d.push({ suit, n, copy: c });
  }
  for (let n = 0; n < 7; n++)
    for (let c = 0; c < 4; c++)
      d.push({ suit: 'honor', n, copy: c });
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function serverInitRound(room) {
  room.deck = shuffle(buildDeck());
  room.hands = [[], [], [], []];
  room.discards = [[], [], [], []];

  for (let i = 0; i < 13; i++) {
    for (let p = 0; p < 4; p++) {
      room.hands[p].push(room.deck.pop());
    }
  }

  room.dora = [room.deck.pop()];
  room.uraDoraHidden = [room.deck.pop()];
  room.turn = room.dealerIdx;
}

const tileKey = t => t.suit + t.n;

/* ===============================
   ✅ CPU自動ツモ
================================= */

function handleCpuTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const seat = room.turn;
  const player = room.players.find(p => p.seatIdx === seat && p.isCpu);
  if (!player) return;

  if (room.deck.length === 0) {
    io.to(roomId).emit("ryukyoku-server");
    return;
  }

  const tile = room.deck.pop();
  room.hands[seat].push(tile);

  io.to(roomId).emit("tile-drawn", {
    playerIdx: seat,
    tile,
    deckRemaining: room.deck.length,
  });
}

/* ===============================
   Socket.IO
================================= */

io.on("connection", socket => {
  console.log("接続:", socket.id);

  socket.on("join-room", ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (room.players.length >= 4) {
      socket.emit("room-full");
      return;
    }

    const seatIdx = room.players.length;
    room.players.push({ id: socket.id, name, seatIdx });
    socket.join(roomId);
    socket.data.roomId = roomId;
    io.to(roomId).emit("room-update", toSeats(room));
  });

  // ホストがCPUで空席を埋めた → 全員に同期
  socket.on("fill-cpu", ({ roomId, names, slotTypes }) => {
    const room = getRoom(roomId);
    // CPUプレイヤーをroom.playersに追加（未登録のseatのみ）
    for (let i = 0; i < 4; i++) {
      if (slotTypes[i] === 'cpu') {
        const exists = room.players.find(p => p.seatIdx === i);
        if (!exists) {
          room.players.push({ id: `cpu_${i}`, name: names[i], seatIdx: i, isCpu: true });
        }
      }
    }
    io.to(roomId).emit("room-update", toSeats(room));
  });

  socket.on("start-game", ({ roomId, names, slotTypes }) => {
    const room = getRoom(roomId);
    room.started = true;

    if (names && slotTypes) {
      for (let i = 0; i < 4; i++) {
        if (slotTypes[i] === "cpu") {
          const exists = room.players.find(p => p.seatIdx === i);
          if (!exists) {
            room.players.push({
              id: `cpu_${i}`,
              name: names[i],
              seatIdx: i,
              isCpu: true,
            });
          }
        }
      }
    }

    serverInitRound(room);

    io.to(roomId).emit("game-start", {
      players: toSeats(room),
      hands: room.hands,
      deck: room.deck,
      dora: room.dora,
      uraDoraHidden: room.uraDoraHidden,
      turn: room.turn,
      dealerIdx: room.dealerIdx,
      scores: room.scores,
      roundNum: room.roundNum,
      honba: room.honba,
    });

    // 開局時のツモはクライアント（ホスト）が draw-tile で制御
  });

  socket.on("draw-tile", ({ roomId }) => {
    const room = getRoom(roomId);
    if (room.deck.length === 0) {
      io.to(roomId).emit("ryukyoku-server");
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const tile = room.deck.pop();
    room.hands[player.seatIdx].push(tile);

    io.to(roomId).emit("tile-drawn", {
      playerIdx: player.seatIdx,
      tile,
      deckRemaining: room.deck.length,
    });
  });

  socket.on("game-action", ({ roomId, data }) => {
    const room = getRoom(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const playerIdx = player?.seatIdx ?? data.playerIdx;

    if (data.type === "discard") {
      const idx = room.hands[playerIdx]?.findIndex(
        t => tileKey(t) === tileKey(data.tile)
      );

      if (idx >= 0) room.hands[playerIdx].splice(idx, 1);
      room.discards[playerIdx].push(data.tile);

      room.turn = (playerIdx + 1) % 4;
    }

    io.to(roomId).emit("game-action", {
      ...data,
      playerIdx,
      turn: room.turn,
      deckRemaining: room.deck.length,
    });

    // 次のツモはクライアント（ホスト）が draw-tile で制御
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

/* ===============================
   起動
================================= */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動 port:${PORT}`);
});