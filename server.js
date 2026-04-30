const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

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
  room.players.forEach(p => { seats[p.seatIdx] = p; });
  return seats;
}

function buildDeck() {
  const d = [];
  for (const suit of ['man', 'pin', 'sou'])
    for (let n = 0; n < 9; n++)
      for (let c = 0; c < 4; c++)
        d.push({ suit, n, copy: c });
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
  for (let i = 0; i < 13; i++)
    for (let p = 0; p < 4; p++)
      room.hands[p].push(room.deck.pop());
  room.dora = [room.deck.pop()];
  room.uraDoraHidden = [room.deck.pop()];
  room.turn = room.dealerIdx;
}

const tileKey = t => t.suit + t.n;

io.on("connection", socket => {
  console.log("接続:", socket.id);

  socket.on("join-room", ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (room.players.length >= 4) { socket.emit("room-full"); return; }
    const seatIdx = room.players.length;
    room.players.push({ id: socket.id, name, seatIdx });
    socket.join(roomId);
    socket.data.roomId = roomId;
    io.to(roomId).emit("room-update", toSeats(room));
  });

  // ホストがCPUで空席を埋めた → 全員に同期
  socket.on("fill-cpu", ({ roomId, names, slotTypes }) => {
    const room = getRoom(roomId);
    for (let i = 0; i < 4; i++) {
      if (slotTypes[i] === 'cpu' && !room.players.find(p => p.seatIdx === i)) {
        room.players.push({ id: `cpu_${i}`, name: names[i], seatIdx: i, isCpu: true });
      }
    }
    io.to(roomId).emit("room-update", toSeats(room));
  });

  socket.on("start-game", ({ roomId, names, slotTypes }) => {
    const room = getRoom(roomId);
    room.started = true;
    if (names && slotTypes) {
      for (let i = 0; i < 4; i++) {
        if (slotTypes[i] === "cpu" && !room.players.find(p => p.seatIdx === i)) {
          room.players.push({ id: `cpu_${i}`, name: names[i], seatIdx: i, isCpu: true });
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
  });

  // draw-tile: forSeat を指定するとその席にツモらせる（CPU代行用）
  // サーバーの room.turn を正として照合する
  socket.on("draw-tile", ({ roomId, forSeat }) => {
    const room = getRoom(roomId);
    if (!room) return;
    if (room.deck.length === 0) { io.to(roomId).emit("ryukyoku-server"); return; }

    // 対象席を決定：forSeat 指定 > 送信者席 → サーバーのターンで検証
    let seatIdx;
    if (forSeat !== undefined && forSeat !== null) {
      seatIdx = forSeat;
    } else {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      seatIdx = player.seatIdx;
    }

    // ターンが合わない場合はサーバーのターンを使う
    if (room.turn !== seatIdx) {
      console.warn(`draw-tile: requested seat=${seatIdx} but room.turn=${room.turn}, using room.turn`);
      seatIdx = room.turn;
    }

    const tile = room.deck.pop();
    room.hands[seatIdx].push(tile);

    io.to(roomId).emit("tile-drawn", {
      playerIdx: seatIdx,
      tile,
      deckRemaining: room.deck.length,
    });
  });

  socket.on("game-action", ({ roomId, data }) => {
    const room = getRoom(roomId);
    if (!room) return;
    // data.playerIdx を正として使う（CPUの捨て牌はホストのsocketから送られるため
    // socket.idでseatを引くとホストの席番号になってしまう）
    const playerIdx = data.playerIdx;

    if (data.type === "discard") {
      const idx = room.hands[playerIdx]?.findIndex(t => tileKey(t) === tileKey(data.tile));
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
  });

  // 次の局開始（ホストが要求）
  socket.on("next-round", ({ roomId, dealerIdx, roundNum, scores, honba }) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.dealerIdx = dealerIdx;
    room.roundNum = roundNum;
    room.scores = scores;
    room.honba = honba;
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
  });

  // 和了・流局をサーバー経由で全員に同期
  socket.on("broadcast-result", ({ roomId, data }) => {
    io.to(roomId).emit("broadcast-result", data);
  });

  // クレームパス（次ターンへ）をサーバー経由で全員に同期
  socket.on("claim-pass", ({ roomId, fromIdx }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const nextSeat = (fromIdx + 1) % 4;
    room.turn = nextSeat;
    io.to(roomId).emit("claim-pass", { fromIdx, nextSeat });
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) delete rooms[roomId];
    else io.to(roomId).emit("room-update", toSeats(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`サーバー起動 port:${PORT}`));
