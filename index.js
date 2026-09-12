// One link to send a client, with nobody having to hold an account.
//
// filebin.net is about as simple as an upload gets: PUT or POST the bytes at
//
//   https://filebin.net/<bin>/<filename>
//
// and the bin is the link. You choose the bin's name, so the link is known
// before the first byte goes anywhere. Several files under one bin means one
// link for a whole set of artboards. Asking for the bin as JSON gives the file
// list and the date it deletes itself, which is worth putting in the email.
//
// Checked against the live service in September 2026: two files under one bin,
// 201 on each upload, a seven day life, and a DELETE that empties it early.

const BASE = "https://filebin.net";

// Bin names live in a URL and are read aloud in emails, so keep them plain.
function slug(text, fallback) {
  const out = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function contentTypeFor(filename) {
  const ext = String(filename).toLowerCase().split(".").pop();
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      tiff: "image/tiff",
      svg: "image/svg+xml",
      eps: "application/postscript",
    }[ext] || "application/octet-stream"
  );
}

module.exports = async (ctx) => {
  // A helper running inside Affinity is waiting synchronously for this HTTP
  // call. Re-entering Affinity through MCP here deadlocks it, so the helper
  // exports the requested image (or artboards) and marks the input direct —
  // exactly like Googly Eyes does.
  const direct = ctx.input.__bridgeDirect === true;
  const doc = direct ? null : await ctx.affinity.info();
  if (!direct && !doc.open) throw new Error("Open a document in Affinity first.");

  const preset = String(ctx.input.format || "PDF (for print)");

  // What is going: one thing, or one file per artboard.
  const pieces = [];
  if (ctx.input.everyArtboard) {
    if (direct) {
      const boards = Array.isArray(ctx.input.__bridgeArtboards) ? ctx.input.__bridgeArtboards : [];
      if (!boards.length) {
        throw new Error("This document has no artboards, or all-artboard export is unavailable from the Affinity helper.");
      }
      for (const board of boards) {
        pieces.push({ ...board, label: board.name || board.filename || "artboard" });
      }
    } else {
      const outline = await ctx.affinity.outline();
      const boards = outline.artboards || [];
      if (!boards.length) {
        throw new Error("This document has no artboards, so there is nothing to send one by one.");
      }
      for (const board of boards) {
        ctx.progress(`Exporting ${board.name || "an artboard"}`);
        const shot = await ctx.affinity.exportArtboard(board.name || board.index, { preset });
        pieces.push({ ...shot, label: board.name || `artboard-${board.index + 1}` });
      }
    }
  } else {
    const source = ctx.input.image;
    if (!source || !source.path) {
      throw new Error("Choose what to send.");
    }
    // An artboard or layer brings its own name; a file keeps the one it had.
    const stem = String(source.filename || "").replace(/\.[^.]+$/, "");
    pieces.push({ ...source, label: source.name || (doc && doc.name) || stem || "proof" });
  }

  const totalBytes = pieces.reduce((sum, p) => sum + (p.bytes || 0), 0);
  ctx.log(`${pieces.length} file${pieces.length === 1 ? "" : "s"}, ${Math.round(totalBytes / 1024)} KB in all`);

  // The link, decided here rather than handed back by the service.
  const bin = `${slug(ctx.input.name || (doc && doc.name) || "proof", "proof")}-${today()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const link = `${BASE}/${bin}`;

  const sent = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const extension = piece.filename.includes(".") ? piece.filename.split(".").pop() : "bin";
    const filename = `${slug(piece.label, `file-${i + 1}`)}.${extension}`;

    ctx.progress(`Uploading ${i + 1} of ${pieces.length}`);
    const bytes = await ctx.files.read(piece.path);
    const reply = await ctx.http(`${link}/${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: {
        "Content-Type": contentTypeFor(filename),
        Accept: "application/json",
        "User-Agent": "Connector for Affinity",
      },
      body: bytes,
    });

    if (!reply.ok) {
      throw new Error(
        `filebin.net refused ${filename} (HTTP ${reply.status}). ${(reply.text || "").slice(0, 200)}`,
      );
    }
    ctx.log(`Sent ${filename}, ${Math.round(bytes.length / 1024)} KB`);
    sent.push({ path: piece.path, caption: filename });
  }

  // Ask the bin about itself, mainly for the date it removes itself.
  let expires = "";
  try {
    const about = await ctx.http.get(link, {
      headers: { Accept: "application/json", "User-Agent": "Connector for Affinity" },
    });
    const when = about.data && about.data.bin && about.data.bin.expired_at;
    // Written the same way whoever reads the email, rather than in whichever
    // order this machine happens to prefer.
    if (when) expires = String(when).slice(0, 10);
  } catch {
    // Not worth failing an upload that worked.
  }

  const note = expires
    ? `${link}\n\nAnyone with this link can download it. It deletes itself on ${expires}.`
    : `${link}\n\nAnyone with this link can download it. It deletes itself after about a week.`;

  return {
    message: `${sent.length} file${sent.length === 1 ? "" : "s"} at ${link}`,
    text: note,
    images: sent,
  };
};
