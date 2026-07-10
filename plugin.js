// Reconectar tokens (Figma -> Penpot)
//
// Cuando pegas un diseño copiado de Figma dentro de Penpot, las capas llegan
// con valores "sueltos" (un hex de color, un font-family, un tamaño...) pero
// SIN vincular a ningún token de Penpot, aunque ya hayas importado esos
// mismos tokens antes (con el plugin Figma -> Penpot Tokens).
//
// Este plugin recorre las capas (selección actual, o toda la página) y por
// cada propiedad soportada (fill, stroke, tipografía, radio de esquina,
// opacidad...) busca, entre los tokens ya existentes en el archivo, uno cuyo
// VALOR RESUELTO coincida exactamente con el valor "suelto" de la capa, y si
// lo encuentra, lo reconecta usando `applyToShapes` / `applyToken` de la API
// de plugins de Penpot.
//
// No inventa valores nuevos ni crea tokens: solo reconecta lo que ya coincide.

// La "v=2" en la URL es a propósito: GitHub Pages sirve ui.html con
// cache-control: max-age=600 (10 min), y el navegador cachea ese fetch de
// forma independiente al de plugin.js. Sin un parámetro que cambie en cada
// versión, Penpot puede seguir mostrando una versión vieja de ui.html
// aunque plugin.js ya se haya actualizado. Sube el número cada vez que
// cambies ui.html.
penpot.ui.open("Reconectar tokens", "ui.html?v=2", { width: 400, height: 700 });

// ---------- Normalización de valores para poder compararlos ----------

function normalizeColor(hex) {
  if (!hex || typeof hex !== "string") return null;
  let h = hex.trim().toLowerCase();
  if (!h.startsWith("#")) h = "#" + h;
  // Nos quedamos con el RGB (7 chars: # + 6 hex). La opacidad se compara
  // aparte (fillOpacity / strokeOpacity), así que no hace falta que el hex
  // incluya alpha para que cuente como coincidencia de color.
  if (h.length >= 7) return h.slice(0, 7);
  return h;
}

function normalizeNumber(v) {
  if (v === null || v === undefined || v === "mixed") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace("px", "").trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

const WEIGHT_TO_NUM = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

// Junta peso + cursiva en una clave comparable, tanto si viene como texto
// ("Semi Bold Italic", "medium") como si viene como número CSS ("400") más
// un fontStyle separado (así es como lo guarda Penpot en las capas de texto).
function normalizeWeight(weightRaw, italic) {
  if (weightRaw === null || weightRaw === undefined || weightRaw === "mixed") return null;
  const raw = String(weightRaw).trim().toLowerCase();
  const hasItalicInText = raw.includes("italic");
  const base = raw.replace("italic", "").trim();
  let num = null;
  if (/^\d+$/.test(base)) {
    num = parseInt(base, 10);
  } else if (WEIGHT_TO_NUM[base] !== undefined) {
    num = WEIGHT_TO_NUM[base];
  } else if (base === "" && hasItalicInText) {
    num = 400;
  }
  if (num === null) return null;
  const isItalic = !!italic || hasItalicInText;
  return num + (isItalic ? "-italic" : "");
}

function normalizeTextCase(v) {
  if (!v || v === "mixed") return "none";
  return String(v).trim().toLowerCase();
}

function normalizeTextDecoration(v) {
  if (!v || v === "mixed" || v === "none") return "none";
  const s = String(v).trim().toLowerCase();
  if (s === "line-through") return "strike-through";
  return s;
}

// ---------- Construcción de índices valor -> token(es) ----------

function buildIndexes(log) {
  const idx = {
    color: new Map(),
    fontFamilies: new Map(),
    fontSizes: new Map(),
    fontWeights: new Map(),
    letterSpacing: new Map(),
    borderRadius: new Map(),
    borderWidth: new Map(),
    opacity: new Map(),
    typography: new Map(),
  };

  function push(map, key, token) {
    if (key === null || key === undefined) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(token);
  }

  const catalog = penpot.library.local.tokens;
  let tokenCount = 0;

  for (const set of catalog.sets) {
    for (const token of set.tokens) {
      tokenCount++;
      const t = token.type;
      const rv = token.resolvedValue;
      if (rv === undefined || rv === null) continue;

      if (t === "color") {
        push(idx.color, normalizeColor(rv), token);
      } else if (t === "fontFamilies") {
        const fams = Array.isArray(rv) ? rv : [rv];
        for (const f of fams) {
          push(idx.fontFamilies, String(f).trim().toLowerCase(), token);
        }
      } else if (t === "fontSizes") {
        push(idx.fontSizes, normalizeNumber(rv), token);
      } else if (t === "fontWeights") {
        push(idx.fontWeights, normalizeWeight(rv, false), token);
      } else if (t === "letterSpacing") {
        push(idx.letterSpacing, normalizeNumber(rv), token);
      } else if (t === "borderRadius") {
        push(idx.borderRadius, normalizeNumber(rv), token);
      } else if (t === "borderWidth") {
        push(idx.borderWidth, normalizeNumber(rv), token);
      } else if (t === "opacity") {
        push(idx.opacity, normalizeNumber(rv), token);
      } else if (t === "typography") {
        const values = Array.isArray(rv) ? rv : [rv];
        for (const v of values) {
          if (!v) continue;
          const key = [
            (v.fontFamilies || []).map((f) => String(f).trim().toLowerCase()).join(","),
            normalizeNumber(v.fontSizes),
            normalizeWeight(v.fontWeights, false),
            normalizeNumber(v.letterSpacing),
            normalizeTextCase(v.textCase),
            normalizeTextDecoration(v.textDecoration),
          ].join("|");
          push(idx.typography, key, token);
        }
      }
    }
  }

  log(`Catálogo: ${tokenCount} tokens en ${catalog.sets.length} sets.`);
  return idx;
}

// ---------- Recorrido de capas ----------

function collectShapes(roots) {
  const out = [];
  function walk(shape) {
    out.push(shape);
    if (Array.isArray(shape.children)) {
      for (const c of shape.children) walk(c);
    }
  }
  for (const r of roots) walk(r);
  return out;
}

// ---------- Aplicación de un match, evitando pisar tokens ya asignados ----------

function alreadyLinked(shape, prop) {
  return !!(shape.tokens && shape.tokens[prop]);
}

// Normaliza un nombre de token/variable para poder compararlos aunque usen
// separadores distintos: Figma usa "color/bg/secondary", Penpot (y nuestro
// exportador) usa "color.bg.secondary".
function normalizeTokenName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[/.]/g, ".");
}

function applyMatch(report, shape, tokenList, props, label, force, hints, matchKey) {
  if (!tokenList || tokenList.length === 0) return "unmatched";
  if (!force && props.every((p) => alreadyLinked(shape, p))) return "skipped";

  let candidates = tokenList;
  let resolvedByHint = false;

  if (tokenList.length > 1 && hints && matchKey && hints[matchKey] && hints[matchKey].length) {
    const wanted = hints[matchKey].map(normalizeTokenName);
    const picked = tokenList.filter((t) => wanted.includes(normalizeTokenName(t.name)));
    if (picked.length >= 1 && picked.length < tokenList.length) {
      candidates = picked;
      resolvedByHint = picked.length === 1;
    }
  }

  if (candidates.length > 1) {
    // Varios tokens tienen exactamente el mismo valor resuelto (p.ej. dos
    // colores semánticos distintos que hoy coinciden en el mismo hex), y no
    // se pudo desambiguar ni por el valor ni con el mapa de Figma (si lo
    // había). No hay forma fiable de adivinar cuál es "el correcto" — así
    // que NO se aplica ninguno automáticamente: se deja constancia para que
    // lo revises tú.
    const names = candidates.map((t) => t.name).join(", ");
    report.ambiguous++;
    report.ambiguousDetails.push(`${label} en "${shape.name}": coinciden ${candidates.length} tokens (${names}) — sin aplicar, revísalo a mano.`);
    return "ambiguous";
  }

  const token = candidates[0];
  try {
    token.applyToShapes([shape], props);
    report.applied++;
    if (resolvedByHint) report.resolvedByFigma++;
    return "applied";
  } catch (err) {
    report.errors.push(`${label} en "${shape.name}": ${(err && err.message) || err}`);
    return "error";
  }
}

// ---------- Procesado de una capa individual ----------

function processShape(shape, idx, report, force, hints) {
  // Fills (color)
  if (Array.isArray(shape.fills)) {
    shape.fills.forEach((fill) => {
      if (!fill || !fill.fillColor) return;
      // Si el fill ya está vinculado a un color de BIBLIOTECA de Penpot
      // (fillColorRefId) —típico cuando el diseño se trajo con un
      // importador tipo "Penpot Exporter" que sí preserva las variables de
      // Figma como colores de biblioteca— no lo tocamos: ya está bien
      // conectado, y no es lo mismo que estar vinculado a un Token.
      if (!force && fill.fillColorRefId) {
        report.skipped++;
        return;
      }
      const key = normalizeColor(fill.fillColor);
      tally(report, applyMatch(report, shape, idx.color.get(key), ["fill"], "fill", force, hints, key));
    });
  }

  // Strokes (color + width)
  if (Array.isArray(shape.strokes)) {
    shape.strokes.forEach((stroke) => {
      if (stroke && stroke.strokeColor) {
        if (!force && stroke.strokeColorRefId) {
          report.skipped++;
        } else {
          const key = normalizeColor(stroke.strokeColor);
          tally(report, applyMatch(report, shape, idx.color.get(key), ["strokeColor"], "strokeColor", force, hints, key));
        }
      }
      if (stroke && stroke.strokeWidth !== undefined) {
        const key = normalizeNumber(stroke.strokeWidth);
        tally(report, applyMatch(report, shape, idx.borderWidth.get(key), ["strokeWidth"], "strokeWidth", force));
      }
    });
  }

  // Opacity
  if (typeof shape.opacity === "number") {
    const key = normalizeNumber(shape.opacity);
    tally(report, applyMatch(report, shape, idx.opacity.get(key), ["opacity"], "opacity", force));
  }

  // Border radius (las 4 esquinas a la vez, con el mismo token si coinciden)
  const corners = ["borderRadiusTopLeft", "borderRadiusTopRight", "borderRadiusBottomRight", "borderRadiusBottomLeft"];
  if (corners.every((c) => typeof shape[c] === "number")) {
    const values = corners.map((c) => normalizeNumber(shape[c]));
    const allEqual = values.every((v) => v === values[0]);
    if (allEqual) {
      tally(report, applyMatch(report, shape, idx.borderRadius.get(values[0]), corners, "borderRadius", force));
    } else {
      corners.forEach((c, i) => {
        tally(report, applyMatch(report, shape, idx.borderRadius.get(values[i]), [c], c, force));
      });
    }
  }

  // Texto: primero intentamos el token de Typography completo (combo
  // exacto), y si no hay match exacto, probamos cada propiedad suelta.
  if (shape.type === "text") {
    const famKey = shape.fontFamily && shape.fontFamily !== "mixed" ? String(shape.fontFamily).trim().toLowerCase() : null;
    const sizeKey = normalizeNumber(shape.fontSize);
    const weightKey = normalizeWeight(shape.fontWeight, shape.fontStyle === "italic");
    const lsKey = normalizeNumber(shape.letterSpacing);
    const caseKey = normalizeTextCase(shape.textTransform);
    const decKey = normalizeTextDecoration(shape.textDecoration);

    const typoKey = [famKey || "", sizeKey, weightKey, lsKey, caseKey, decKey].join("|");
    const typoMatch = idx.typography.get(typoKey);

    if (typoMatch && typoMatch.length > 0) {
      tally(report, applyMatch(report, shape, typoMatch, ["typography"], "typography", force));
    } else {
      if (famKey) tally(report, applyMatch(report, shape, idx.fontFamilies.get(famKey), ["fontFamilies"], "fontFamilies", force));
      if (sizeKey !== null) tally(report, applyMatch(report, shape, idx.fontSizes.get(sizeKey), ["fontSize"], "fontSize", force));
      if (weightKey !== null) tally(report, applyMatch(report, shape, idx.fontWeights.get(weightKey), ["fontWeight"], "fontWeight", force));
      if (lsKey !== null) tally(report, applyMatch(report, shape, idx.letterSpacing.get(lsKey), ["letterSpacing"], "letterSpacing", force));
    }
  }
}

function tally(report, result) {
  if (result === "unmatched") report.unmatched++;
  else if (result === "skipped") report.skipped++;
  // "applied" y "error" ya se cuentan dentro de applyMatch
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Lógica principal ----------
//
// Se procesa en lotes con una pequeña pausa entre ellos (`sleep(0)`) para
// devolver el control al navegador. Sin esto, un diseño grande (cientos o
// miles de capas, típico al traer un frame completo desde Figma) bloquea el
// hilo principal el tiempo suficiente para que el navegador muestre
// "La página no responde".

const CHUNK_SIZE = 12;

function emptyReport() {
  return { applied: 0, unmatched: 0, ambiguous: 0, skipped: 0, resolvedByFigma: 0, ambiguousDetails: [], errors: [] };
}

async function run(options, log, done) {
  const { scope, force, hints } = options;

  let roots;
  if (scope === "selection" && penpot.selection && penpot.selection.length > 0) {
    roots = penpot.selection;
  } else {
    const page = penpot.currentPage;
    roots = page && page.root && page.root.children ? page.root.children : [];
  }

  if (roots.length === 0) {
    log("No hay capas en el ámbito elegido (¿seleccionaste algo?).");
    done(emptyReport());
    return;
  }

  const idx = buildIndexes(log);
  await sleep(0);

  const shapes = collectShapes(roots);
  log(`Revisando ${shapes.length} capas...`);
  if (shapes.length > 300) {
    log(`Son bastantes capas — puede tardar uno o dos minutos. No cierres el plugin, va actualizando el progreso.`);
  }
  if (hints && Object.keys(hints).length > 0) {
    log(`Usando ${Object.keys(hints).length} valores de color leídos de Figma para desambiguar.`);
  }

  const report = emptyReport();

  for (let i = 0; i < shapes.length; i++) {
    processShape(shapes[i], idx, report, force, hints);

    if (i % CHUNK_SIZE === CHUNK_SIZE - 1 || i === shapes.length - 1) {
      if (shapes.length > 300) {
        log(`Procesadas ${i + 1}/${shapes.length}...`);
      }
      // Cede el control al navegador entre lotes para que la pestaña no se
      // quede congelada mientras se procesan muchas capas.
      await sleep(0);
    }
  }

  log("Listo.");
  done(report);
}

// ---------- Comunicación con la UI ----------

penpot.ui.onMessage((msg) => {
  if (!msg || msg.type !== "run") return;
  const log = (text) => penpot.ui.sendMessage({ type: "log", text });
  run(msg.options || {}, log, (report) => {
    penpot.ui.sendMessage({ type: "result", report });
  }).catch((err) => {
    penpot.ui.sendMessage({ type: "error", message: (err && err.message) || String(err) });
  });
});
