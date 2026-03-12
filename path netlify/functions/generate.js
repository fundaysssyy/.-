const { createCanvas, loadImage } = require("canvas");

// Rate limit storage (in-memory, reset tiap deploy)
const rateLimitStore = {};
const DAILY_LIMIT = 100;

function getClientIP(event) {
  return (
    event.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    "unknown"
  );
}

function getTodayKey(ip) {
  const today = new Date().toISOString().split("T")[0];
  return `${ip}_${today}`;
}

function getRateLimit(ip) {
  const key = getTodayKey(ip);
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 0, resetAt: Date.now() + 86400000 };
  }
  // Reset kalau udah expired
  if (Date.now() > rateLimitStore[key].resetAt) {
    rateLimitStore[key] = { count: 0, resetAt: Date.now() + 86400000 };
  }
  return rateLimitStore[key];
}

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const ip = getClientIP(event);

  // GET - cek rate limit
  if (event.httpMethod === "GET") {
    const rl = getRateLimit(ip);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        remaining: Math.max(0, DAILY_LIMIT - rl.count),
        limit: DAILY_LIMIT,
        used: rl.count,
      }),
    };
  }

  // POST - generate gambar
  if (event.httpMethod === "POST") {
    const rl = getRateLimit(ip);
    if (rl.count >= DAILY_LIMIT) {
      return {
        statusCode: 429,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Rate limit exceeded. Coba lagi besok!" }),
      };
    }

    try {
      // Parse multipart form data
      const contentType = event.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        return {
          statusCode: 400,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Content-Type harus multipart/form-data" }),
        };
      }

      // Decode body
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body);

      // Parse boundary
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) throw new Error("Boundary tidak ditemukan");
      const boundary = "--" + boundaryMatch[1];

      // Split parts
      const parts = body.toString("binary").split(boundary);
      let imageBuffer = null;
      let username = "";

      for (const part of parts) {
        if (part.includes('name="image"')) {
          const match = part.match(/\r\n\r\n([\s\S]*)\r\n$/);
          if (match) {
            imageBuffer = Buffer.from(match[1], "binary");
          }
        }
        if (part.includes('name="username"')) {
          const match = part.match(/\r\n\r\n([\s\S]*)\r\n$/);
          if (match) {
            username = match[1].trim().slice(0, 20);
          }
        }
      }

      if (!imageBuffer || !username) {
        return {
          statusCode: 400,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Image dan username diperlukan" }),
        };
      }

      // Load gambar user sebagai template
      const templateImg = await loadImage(imageBuffer);
      const W = templateImg.width;
      const H = templateImg.height;

      // Buat canvas
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d");

      // Draw template
      ctx.drawImage(templateImg, 0, 0, W, H);

      // Scale koordinat kotak nama ke ukuran gambar user
      // Referensi: 736x1307, kotak: X:232 Y:1014, W:276 H:49
      const scaleX = W / 736;
      const scaleY = H / 1307;

      const boxX = Math.round(232 * scaleX);
      const boxY = Math.round(1014 * scaleY);
      const boxW = Math.round(276 * scaleX);
      const boxH = Math.round(49 * scaleY);
      const centerX = Math.round(370 * scaleX);
      const centerY = Math.round(1038 * scaleY);

      // Kotak transparan hitam
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      const r = 6 * Math.min(scaleX, scaleY);
      ctx.moveTo(boxX + r, boxY);
      ctx.lineTo(boxX + boxW - r, boxY);
      ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
      ctx.lineTo(boxX + boxW, boxY + boxH - r);
      ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
      ctx.lineTo(boxX + r, boxY + boxH);
      ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
      ctx.lineTo(boxX, boxY + r);
      ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Teks username
      const fontSize = Math.round(22 * Math.min(scaleX, scaleY));
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.font = `bold ${fontSize}px Arial`;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Shadow biar keliatan di background apapun
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 4;
      ctx.fillText(username, centerX, centerY);
      ctx.restore();

      // Export ke PNG
      const outputBuffer = canvas.toBuffer("image/png");

      // Increment rate limit
      rl.count++;

      return {
        statusCode: 200,
        headers: {
          ...headers,
          "Content-Type": "image/png",
          "Content-Length": outputBuffer.length.toString(),
          "Content-Disposition": `attachment; filename="FakeML_${username}.png"`,
        },
        body: outputBuffer.toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      console.error("Generate error:", err);
      return {
        statusCode: 500,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Gagal generate: " + err.message }),
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
