"use client";
import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";

export default function Home() {
  const [status, setStatus] = useState("disconnected");
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState<
    { username: string; text: string }[]
  >([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => setStatus("connected"));
    socket.on("disconnect", () => setStatus("disconnected"));

    socket.on("room:joined", (data) => {
      console.log("room:joined", data);
      setJoined(true);
    });

    socket.on("room:member_joined", ({ username }) => {
      setMessages((prev) => [
        ...prev,
        { username: "system", text: `${username} joined` },
      ]);
    });

    socket.on("chat:message", ({ username, text }) => {
      setMessages((prev) => [...prev, { username, text }]);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("room:joined");
      socket.off("room:member_joined");
      socket.off("chat:message");
    };
  }, []);

  function joinRoom() {
    if (!roomId || !username) return;
    const socket = getSocket();
    socket.connect();
    socket.emit("room:join", { roomId, userId: username, username });
  }

  function sendMessage() {
    if (!input) return;
    const socket = getSocket();
    socket.emit("chat:send", {
      roomId,
      userId: username,
      username,
      text: input,
    });
    setInput("");
  }

  return (
    <main className="min-h-screen bg-black text-white p-8 font-mono">
      <h1 className="text-2xl font-bold mb-6">vaux</h1>

      {!joined ? (
        <div className="flex flex-col gap-3 max-w-sm">
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            placeholder="room id (e.g. indie-night)"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            placeholder="your name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button
            className="bg-violet-600 hover:bg-violet-500 rounded px-4 py-2 text-sm font-bold"
            onClick={joinRoom}
          >
            join room
          </button>
        </div>
      ) : (
        <div className="max-w-lg">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-zinc-400 text-sm">room:</span>
            <span className="text-violet-400 font-bold">{roomId}</span>
            <span
              className={`ml-auto text-xs ${status === "connected" ? "text-green-400" : "text-red-400"}`}
            >
              {status}
            </span>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded p-4 h-64 overflow-y-auto mb-3 flex flex-col gap-1">
            {messages.map((m, i) => (
              <div key={i} className="text-sm">
                <span
                  className={
                    m.username === "system"
                      ? "text-zinc-500 italic"
                      : "text-violet-400"
                  }
                >
                  {m.username === "system" ? "" : `${m.username}: `}
                </span>
                <span
                  className={
                    m.username === "system"
                      ? "text-zinc-500 italic"
                      : "text-zinc-100"
                  }
                >
                  {m.text}
                </span>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
              placeholder="say something..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            />
            <button
              className="bg-violet-600 hover:bg-violet-500 rounded px-4 py-2 text-sm font-bold"
              onClick={sendMessage}
            >
              send
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
