/* Generative artwork — ภาพนามธรรมที่สร้างจาก seed (ต้นฉบับ ไม่ได้ลอกงานศิลปินคนใด)
 * ใช้กับ imageURI รูปแบบ "gen:<seed>" เช่น gen:42 */
(() => {
  const PALETTES = [
    ["#efe6d2", "#e2462c", "#1d3557", "#f2b134", "#141414"],
    ["#f4efe6", "#2a6f5e", "#e9a03b", "#c2462e", "#1b1b1b"],
    ["#ece4d8", "#3d5a80", "#ee6c4d", "#98c1d9", "#293241"],
    ["#f6f1e7", "#b5838d", "#6d6875", "#e5989b", "#2b2d42"],
    ["#efe9df", "#264653", "#2a9d8f", "#e9c46a", "#e76f51"],
    ["#f1ece2", "#0f4c5c", "#e36414", "#fb8b24", "#5f0f40"],
    ["#eee8dc", "#283618", "#606c38", "#dda15e", "#bc6c25"],
  ];

  function rng(seed) {
    let t = (Number(seed) || 0) * 2654435761 >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  function sun(r, P, W, H) {
    const [bg, a, b, c, ink] = P;
    const hz = H * (0.55 + r() * 0.15);
    const R = W * (0.22 + r() * 0.12);
    const cx = W * (0.3 + r() * 0.4);
    let s = `<rect width="${W}" height="${H}" fill="${bg}"/>`;
    s += `<rect y="${hz}" width="${W}" height="${H - hz}" fill="${b}"/>`;
    s += `<circle cx="${cx}" cy="${hz}" r="${R}" fill="${a}"/>`;
    for (let i = 0; i < 6; i++) s += `<rect y="${hz + 10 + i * 14}" width="${W}" height="${3 + i}" fill="${bg}" opacity=".9"/>`;
    s += `<circle cx="${W * (0.15 + r() * 0.7)}" cy="${H * 0.18}" r="${W * 0.035}" fill="${c}"/>`;
    s += `<line x1="0" y1="${hz}" x2="${W}" y2="${hz}" stroke="${ink}" stroke-width="2"/>`;
    return s;
  }

  function bauhaus(r, P, W, H) {
    const n = 3, cw = W / n, ch = H / 4;
    let s = `<rect width="${W}" height="${H}" fill="${P[0]}"/>`;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < n; x++) {
        const X = x * cw, Y = y * ch, col = pick(r, P.slice(1)), t = Math.floor(r() * 5);
        if (r() < 0.25) s += `<rect x="${X}" y="${Y}" width="${cw}" height="${ch}" fill="${pick(r, P.slice(1))}"/>`;
        if (t === 0) s += `<circle cx="${X + cw / 2}" cy="${Y + ch / 2}" r="${Math.min(cw, ch) * 0.4}" fill="${col}"/>`;
        else if (t === 1) s += `<path d="M${X} ${Y + ch} A${cw} ${ch} 0 0 1 ${X + cw} ${Y}" fill="none" stroke="${col}" stroke-width="${cw * 0.18}"/>`;
        else if (t === 2) s += `<path d="M${X} ${Y} L${X + cw} ${Y} L${X} ${Y + ch}Z" fill="${col}"/>`;
        else if (t === 3) s += `<path d="M${X} ${Y + ch} A${cw / 2} ${cw / 2} 0 0 1 ${X + cw} ${Y + ch}Z" fill="${col}"/>`;
        else s += `<rect x="${X + cw * 0.38}" y="${Y}" width="${cw * 0.24}" height="${ch}" fill="${col}"/>`;
      }
    return s;
  }

  function arches(r, P, W, H) {
    let s = `<rect width="${W}" height="${H}" fill="${P[0]}"/>`;
    const cx = W * (0.35 + r() * 0.3), base = H * 0.92, k = 5 + Math.floor(r() * 3);
    for (let i = 0; i < k; i++) {
      const w = W * 0.8 * (1 - i / k), h = H * 0.75 * (1 - i / (k + 1));
      s += `<path d="M${cx - w / 2} ${base} L${cx - w / 2} ${base - h + w / 2} A${w / 2} ${w / 2} 0 0 1 ${cx + w / 2} ${base - h + w / 2} L${cx + w / 2} ${base}Z" fill="${P[1 + (i % 4)]}"/>`;
    }
    s += `<rect y="${base}" width="${W}" height="${H - base}" fill="${P[4]}"/>`;
    s += `<circle cx="${W * (0.12 + r() * 0.76)}" cy="${H * 0.14}" r="${W * 0.05}" fill="${P[1]}"/>`;
    return s;
  }

  function blobs(r, P, W, H) {
    let s = `<rect width="${W}" height="${H}" fill="${P[0]}"/>`;
    const k = 4 + Math.floor(r() * 3);
    for (let i = 0; i < k; i++) {
      const cx = W * r(), cy = H * r(), R = W * (0.12 + r() * 0.22), pts = 7;
      let d = "";
      const P2 = [];
      for (let j = 0; j < pts; j++) {
        const ang = (j / pts) * Math.PI * 2, rr = R * (0.7 + r() * 0.5);
        P2.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
      }
      for (let j = 0; j < pts; j++) {
        const p0 = P2[j], p1 = P2[(j + 1) % pts], m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        d += j === 0 ? `M${m[0]} ${m[1]}` : "";
        const p2 = P2[(j + 2) % pts], m2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        d += ` Q${p1[0]} ${p1[1]} ${m2[0]} ${m2[1]}`;
      }
      s += `<path d="${d}Z" fill="${P[1 + (i % 4)]}" opacity="${0.85 + r() * 0.15}"/>`;
    }
    s += `<path d="M${W * 0.1} ${H * (0.2 + r() * 0.6)} C ${W * 0.4} ${H * r()}, ${W * 0.6} ${H * r()}, ${W * 0.9} ${H * (0.2 + r() * 0.6)}" fill="none" stroke="${P[4]}" stroke-width="3"/>`;
    return s;
  }

  function stripes(r, P, W, H) {
    let s = `<rect width="${W}" height="${H}" fill="${P[0]}"/>`;
    let x = 0;
    while (x < W) {
      const w = W * (0.04 + r() * 0.14);
      if (r() > 0.3) s += `<rect x="${x}" y="0" width="${w}" height="${H}" fill="${pick(r, P.slice(1))}"/>`;
      x += w;
    }
    const R = W * 0.26;
    s += `<circle cx="${W / 2}" cy="${H * (0.35 + r() * 0.3)}" r="${R}" fill="${P[0]}"/>`;
    s += `<circle cx="${W / 2}" cy="${H * 0.5}" r="${R * 0.55}" fill="${P[1]}" opacity=".95"/>`;
    return s;
  }

  const COMPOSITIONS = [sun, bauhaus, arches, blobs, stripes];

  /** คืนค่า SVG string ของภาพจาก seed */
  function artSVG(seed, W = 400, H = 500) {
    const r = rng(seed);
    const P = PALETTES[Math.floor(r() * PALETTES.length)];
    const comp = COMPOSITIONS[Math.floor(r() * COMPOSITIONS.length)];
    const id = "g" + Math.abs(Number(seed) || 0);
    const grain = `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .09 0"/></filter>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${grain}${comp(r, P, W, H)}<rect width="${W}" height="${H}" filter="url(#${id})"/></svg>`;
  }

  window.BidArt = { artSVG };
})();
