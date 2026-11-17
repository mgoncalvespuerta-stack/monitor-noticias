/* Monitor de noticias — Álvaro Uribe y coyuntura nacional
 *
 * Orden de carga (si un paso falla se intenta el siguiente):
 *   1. /api/noticias          -> servidor local (python3 server.py), lee ~25 feeds RSS reales
 *   2. data/respaldo.json     -> sitio publicado: archivo renovado cada 30 min (si es reciente)
 *   3. rss2json.com           -> modo simple (python -m http.server), menos fuentes
 *   4. copia en el navegador  -> última carga real guardada en este equipo
 *   5. data/respaldo.json     -> copia de noticias reales, aunque sea antigua
 */

const AUTO_REFRESH_MS = 30 * 60 * 1000;
const ARCHIVO_RECIENTE_MS = 2 * 60 * 60 * 1000;
const POR_PAGINA = 30;
const CLAVE_COPIA = 'monitor-noticias-copia';
const CLAVE_LETRA = 'monitor-noticias-letra';

const GOOGLE_NEWS = 'https://news.google.com/rss/search?hl=es-419&gl=CO&ceid=CO:es-419&q=';
const FEEDS_MODO_SIMPLE = [
  { url: GOOGLE_NEWS + encodeURIComponent('"Álvaro Uribe" when:10d'), seccion: 'mencion', google: true },
  { url: 'https://news.google.com/rss/headlines/section/topic/NATION?hl=es-419&gl=CO&ceid=CO:es-419', seccion: 'coyuntura', google: true },
  { url: 'https://www.eltiempo.com/rss/politica.xml', seccion: 'coyuntura', fuente: 'El Tiempo' },
  { url: 'https://www.semana.com/arc/outboundfeeds/rss/category/politica/?outputType=xml', seccion: 'coyuntura', fuente: 'Semana' },
  { url: 'https://www.elcolombiano.com/rss/colombia.xml', seccion: 'coyuntura', fuente: 'El Colombiano' },
  { url: 'https://www.larepublica.co/rss/', seccion: 'coyuntura', fuente: 'La República' },
];

const RE_MENCION =
  /[aá]lvaro\s+uribe|uribe\s+v[eé]lez|ex\s?presidente\s+(?:[aá]lvaro\s+)?uribe|presidente\s+uribe|senador\s+uribe/i;

const ETIQUETA_TAMANO = {
  local: 'Medio pequeño / local',
  regional: 'Medio regional',
  nacional: 'Medio nacional',
  gran: 'Gran medio',
  internacional: 'Medio internacional',
  redes: 'Redes sociales',
};

const ETIQUETA_TONO = {
  favorable: 'Favorable',
  desfavorable: 'Desfavorable',
  neutra: 'Neutra',
};

const ETIQUETA_CATEGORIA = {
  coyuntura: 'Coyuntura nacional',
  mencion: 'Mención al presidente Uribe',
};

const state = {
  filter: 'all',
  size: 'all',
  tema: 'all',
  tono: 'all',
  query: '',
  visibles: POR_PAGINA,
  noticias: [],
  abiertas: new Set(),
  historiasAbiertas: new Set(),
  ultimaCarga: 0,
  cargando: false,
};

const $ = (id) => document.getElementById(id);
const totalNewsEl = $('total-news');
const coyunturaCountEl = $('conjuntura-count');
const mencionCountEl = $('mencion-count');
const sourcesCountEl = $('sources-count');
const resultCountEl = $('resultCount');
const newsGridEl = $('newsGrid');
const searchInputEl = $('searchInput');
const limpiarBusquedaEl = $('limpiarBusqueda');
const refreshButtonEl = $('refreshButton');
const refreshTextoEl = $('refreshTexto');
const lastUpdatedEl = $('lastUpdated');
const proximaEl = $('proximaActualizacion');
const pildoraEl = $('estadoPildora');
const avisoEl = $('aviso');
const botonMasEl = $('botonMas');
const fuentesEl = $('seguimiento');
const listaFuentesEl = $('listaFuentes');
const botonLetraEl = $('botonLetra');

/* ------------------------------------------------------------ utilidades */

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function textoPlano(html) {
  const caja = document.createElement('div');
  caja.innerHTML = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  return (caja.textContent || '').replace(/\s+/g, ' ').trim();
}

function recortar(texto, maximo) {
  if (texto.length <= maximo) return texto;
  const trozo = texto.slice(0, maximo);
  return trozo.slice(0, trozo.lastIndexOf(' ')).replace(/[,;:\s]+$/, '') + '…';
}

function enlaceSeguro(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

function crear(etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

const fmtHora = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' });
const fmtDia = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtCompleta = new Intl.DateTimeFormat('es-CO', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function claveDia(fecha) {
  return `${fecha.getFullYear()}-${fecha.getMonth()}-${fecha.getDate()}`;
}

function tituloDia(fecha) {
  const hoy = new Date();
  const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
  if (claveDia(fecha) === claveDia(hoy)) return `Hoy, ${fmtDia.format(fecha)}`;
  if (claveDia(fecha) === claveDia(ayer)) return `Ayer, ${fmtDia.format(fecha)}`;
  return fmtDia.format(fecha);
}

function haceCuanto(fecha) {
  const minutos = Math.round((Date.now() - fecha.getTime()) / 60000);
  if (minutos < 2) return 'Hace un momento';
  if (minutos < 60) return `Hace ${minutos} minutos`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return horas === 1 ? 'Hace 1 hora' : `Hace ${horas} horas`;
  return fmtHora.format(fecha);
}

/* ------------------------------------------------------------ fuentes de datos */

async function pedirJson(url, milisegundos) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), milisegundos);
  try {
    const respuesta = await fetch(url, { cache: 'no-store', signal: control.signal });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
    return await respuesta.json();
  } finally {
    clearTimeout(reloj);
  }
}

function datosValidos(datos) {
  return datos && Array.isArray(datos.noticias) && datos.noticias.length > 0;
}

// 1. Servidor local
async function desdeServidor(forzar) {
  const datos = await pedirJson(`api/noticias${forzar ? '?forzar=1' : ''}`, 40000);
  // En un sitio estático esta ruta no existe (404) y se pasa al siguiente paso
  if (!datosValidos(datos)) throw new Error('El servidor no devolvió noticias');
  return datos;
}

// 2. Sitio publicado (GitHub Pages): no hay servidor, pero una tarea automática
//    renueva data/respaldo.json cada 30 minutos. Si el archivo es reciente, cuenta como en vivo.
async function desdeArchivoReciente() {
  const datos = await pedirJson(`data/respaldo.json?t=${Date.now()}`, 15000);
  const edad = Date.now() - new Date(datos && datos.generado).getTime();
  if (!datosValidos(datos) || !(edad < ARCHIVO_RECIENTE_MS)) throw new Error('Archivo de noticias desactualizado');
  return { ...datos, origen: 'vivo' };
}

// 3. Modo simple: los feeds se leen a través de rss2json (admite CORS)
async function desdeRss2json() {
  let medios = {};
  try {
    medios = await pedirJson('data/medios.json', 8000);
  } catch (error) {
    /* sin tabla de medios: todo queda como medio pequeño */
  }

  const tamanoDe = (fuente, enlace) => {
    let dominio = '';
    try {
      dominio = new URL(enlace).hostname.replace(/^www\./, '');
    } catch (error) {
      /* enlace raro */
    }
    if ((medios.redes || []).includes(normalizar(fuente))) return 'redes';
    const etiqueta = `${normalizar(fuente)} ${dominio.includes('google.') ? '' : dominio}`;
    for (const tamano of ['regional', 'nacional', 'internacional', 'gran']) {
      if ((medios[tamano] || []).some((clave) => etiqueta.includes(normalizar(clave)))) return tamano;
    }
    return 'local';
  };

  const lotes = await Promise.all(
    FEEDS_MODO_SIMPLE.map(async (feed) => {
      try {
        const datos = await pedirJson(
          `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`,
          15000
        );
        if (datos.status !== 'ok') return [];
        return (datos.items || []).map((item) => {
          let titulo = textoPlano(item.title);
          let fuente = feed.fuente || 'Fuente externa';
          let descripcion = textoPlano(item.description);
          const contenido = textoPlano(item.content);
          if (feed.google) {
            const corte = titulo.lastIndexOf(' - ');
            if (corte > 0) {
              fuente = titulo.slice(corte + 3);
              titulo = titulo.slice(0, corte);
            }
            descripcion = '';
          }
          const largo = contenido.length > descripcion.length ? contenido : descripcion;
          const resumen = recortar(descripcion || contenido, 240);
          const fecha = new Date(String(item.pubDate || '').replace(' ', 'T') + 'Z');
          const esMencion = feed.seccion === 'mencion' || RE_MENCION.test(`${titulo} ${largo}`);
          return {
            id: normalizar(titulo).replace(/[^a-z0-9]/g, '').slice(0, 90),
            titulo,
            resumen,
            detalle: largo.length > resumen.length + 40 ? recortar(largo, 750) : '',
            cita: '',
            enlace: item.link,
            fuente,
            fecha: isNaN(fecha) ? new Date().toISOString() : fecha.toISOString(),
            categoria: esMencion ? 'mencion' : 'coyuntura',
            tamano: tamanoDe(fuente, item.link),
          };
        });
      } catch (error) {
        console.warn('Fuente no disponible:', feed.url, error);
        return [];
      }
    })
  );

  const unicas = new Map();
  lotes.flat().forEach((noticia) => {
    if (noticia.titulo && !unicas.has(noticia.id)) unicas.set(noticia.id, noticia);
  });
  const noticias = [...unicas.values()];
  if (noticias.length < 5) throw new Error('rss2json no devolvió suficientes noticias');
  return { generado: new Date().toISOString(), origen: 'vivo', modo: 'simple', fuentes: [], noticias };
}

// 4. Última carga real guardada en este navegador
function desdeCopiaNavegador() {
  const datos = JSON.parse(localStorage.getItem(CLAVE_COPIA) || 'null');
  if (!datosValidos(datos)) throw new Error('Sin copia en el navegador');
  return { ...datos, origen: 'respaldo' };
}

// 5. Copia local en disco
async function desdeArchivo() {
  const datos = await pedirJson('data/respaldo.json', 10000);
  if (!datosValidos(datos)) throw new Error('Respaldo vacío');
  return { ...datos, origen: 'respaldo' };
}

async function obtenerDatos(forzar) {
  const pasos = [() => desdeServidor(forzar), desdeArchivoReciente, desdeRss2json, async () => desdeCopiaNavegador(), desdeArchivo];
  for (const paso of pasos) {
    try {
      const datos = await paso();
      if (datosValidos(datos)) return datos;
    } catch (error) {
      console.warn('Paso de carga omitido:', error.message || error);
    }
  }
  return null;
}

/* ------------------------------------------------------------ carga y estado */

function mostrarEstado(datos) {
  const enVivo = datos && datos.origen === 'vivo';
  const generado = datos && datos.generado ? new Date(datos.generado) : null;

  pildoraEl.className = `pildora ${enVivo ? 'pildora-vivo' : 'pildora-respaldo'}`;
  pildoraEl.textContent = enVivo ? 'En vivo' : 'Copia guardada';

  lastUpdatedEl.textContent = generado
    ? `Última actualización: ${fmtCompleta.format(generado)}`
    : 'Última actualización: sin datos';

  const proxima = new Date(Date.now() + AUTO_REFRESH_MS);
  proximaEl.textContent = `Se actualiza sola cada 30 minutos. Próxima: ${fmtHora.format(proxima)}`;

  if (!datos) {
    avisoEl.hidden = false;
    avisoEl.textContent =
      'No fue posible cargar noticias. Revise la conexión a internet y presione «Actualizar ahora».';
  } else if (!enVivo) {
    avisoEl.hidden = false;
    avisoEl.textContent =
      'No se pudo conectar con los medios en este momento. Se muestran las últimas noticias reales guardadas' +
      (generado ? ` el ${fmtCompleta.format(generado)}.` : '.') +
      ' La página volverá a intentarlo sola.';
  } else if (datos.modo === 'simple') {
    avisoEl.hidden = false;
    avisoEl.textContent =
      'Modo reducido: se están leyendo menos fuentes. Para ver todos los medios, abra el sitio con «python3 server.py».';
  } else {
    avisoEl.hidden = true;
  }
}

function mostrarFuentes(fuentes) {
  listaFuentesEl.replaceChildren();
  if (!Array.isArray(fuentes) || !fuentes.length) {
    fuentesEl.hidden = true;
    return;
  }
  fuentes.forEach((fuente) => {
    const item = crear('li', fuente.ok ? '' : 'caida', fuente.ok ? `✓ ${fuente.nombre}` : `Sin respuesta: ${fuente.nombre}`);
    listaFuentesEl.append(item);
  });
  fuentesEl.hidden = false;
}

async function handleRefresh(forzar = false) {
  if (state.cargando) return;
  state.cargando = true;
  refreshButtonEl.disabled = true;
  refreshButtonEl.classList.add('cargando');
  refreshTextoEl.textContent = 'Actualizando…';

  try {
    const datos = await obtenerDatos(forzar);
    if (datos) {
      state.noticias = datos.noticias
        .filter((noticia) => noticia && noticia.titulo && !isNaN(new Date(noticia.fecha)))
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      if (datos.origen === 'vivo') {
        try {
          localStorage.setItem(CLAVE_COPIA, JSON.stringify(datos));
        } catch (error) {
          /* almacenamiento lleno o bloqueado: no es grave */
        }
      }
    }
    state.ultimaCarga = Date.now();
    mostrarEstado(datos);
    mostrarFuentes(datos && datos.fuentes);
    renderNews();
  } finally {
    state.cargando = false;
    refreshButtonEl.disabled = false;
    refreshButtonEl.classList.remove('cargando');
    refreshTextoEl.textContent = 'Actualizar ahora';
  }
}

/* ------------------------------------------------------------ filtros y pintado */

function coincideBusqueda(noticia, palabras) {
  if (!palabras.length) return true;
  const pajar = normalizar(
    `${noticia.titulo} ${noticia.resumen} ${noticia.detalle} ${noticia.cita} ${noticia.fuente}`
  );
  return palabras.every((palabra) => pajar.includes(palabra));
}

function temaDe(noticia) {
  return noticia.tema || 'Otros temas';
}

// Los botones de tema se arman con los temas que traen las noticias, del más frecuente al menos
function renderTemas() {
  const conteo = new Map();
  state.noticias.forEach((noticia) => conteo.set(temaDe(noticia), (conteo.get(temaDe(noticia)) || 0) + 1));
  const temas = [...conteo.entries()].sort((a, b) => (a[0] === 'Otros temas') - (b[0] === 'Otros temas') || b[1] - a[1]);
  if (state.tema !== 'all' && !conteo.has(state.tema)) state.tema = 'all';

  const grupo = $('grupoTemas');
  grupo.replaceChildren();
  [['all', state.noticias.length], ...temas].forEach(([tema, cantidad]) => {
    const boton = crear('button', `tema-btn${state.tema === tema ? ' activo' : ''}`);
    boton.type = 'button';
    boton.setAttribute('aria-pressed', String(state.tema === tema));
    boton.append(tema === 'all' ? 'Todos los temas' : tema, ' ', crear('span', 'conteo', String(cantidad)));
    boton.addEventListener('click', () => {
      state.tema = tema;
      state.visibles = POR_PAGINA;
      renderNews();
    });
    grupo.append(boton);
  });
}

function getFilteredNews() {
  const palabras = normalizar(state.query).split(/\s+/).filter(Boolean);
  return state.noticias.filter(
    (noticia) =>
      (state.filter === 'all' ||
        noticia.categoria === state.filter ||
        (state.filter === 'prioritaria' && noticia.categoria === 'coyuntura' && noticia.interes === 'prioritaria')) &&
      (state.size === 'all' || noticia.tamano === state.size) &&
      (state.tema === 'all' || temaDe(noticia) === state.tema) &&
      (state.tono === 'all' || noticia.tono === state.tono) &&
      coincideBusqueda(noticia, palabras)
  );
}

function updateStats() {
  const todas = state.noticias;
  const contar = (campo, valor) => todas.filter((noticia) => noticia[campo] === valor).length;

  totalNewsEl.textContent = todas.length;
  coyunturaCountEl.textContent = contar('categoria', 'coyuntura');
  mencionCountEl.textContent = contar('categoria', 'mencion');
  sourcesCountEl.textContent = new Set(todas.map((noticia) => noticia.fuente)).size;

  // El botón de coyuntura prioritaria solo aparece cuando la IA ya la clasificó
  $('filtroPrioritaria').hidden = !todas.some((noticia) => noticia.interes === 'prioritaria');

  // El filtro de tono solo aparece cuando las menciones ya vienen analizadas
  $('bloqueTono').hidden = !todas.some((noticia) => noticia.tono);

  document.querySelectorAll('[data-conteo]').forEach((nodo) => {
    const clave = nodo.dataset.conteo;
    if (clave === 'all') nodo.textContent = todas.length;
    else if (clave === 'coyuntura' || clave === 'mencion') nodo.textContent = contar('categoria', clave);
    else if (clave === 'prioritaria') nodo.textContent = contar('interes', 'prioritaria');
    else if (clave.startsWith('tono-')) nodo.textContent = contar('tono', clave.slice(5));
    else nodo.textContent = contar('tamano', clave);
  });
}

// Círculo con el logo del medio (su ícono oficial). Si no carga, queda la inicial.
function crearAvatar(noticia) {
  const inicial = (noticia.fuente.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/) || ['•'])[0].toUpperCase();
  const avatar = crear('span', 'avatar', inicial);
  avatar.setAttribute('aria-hidden', 'true');
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(noticia.dominio || '')) {
    const logo = crear('img');
    logo.alt = '';
    logo.loading = 'lazy';
    const opciones = [
      `https://icons.duckduckgo.com/ip3/${noticia.dominio}.ico`,
      `https://www.google.com/s2/favicons?domain=${noticia.dominio}&sz=64`,
    ];
    logo.addEventListener('error', () => {
      if (opciones.length) logo.src = opciones.shift();
      else logo.remove();
    });
    logo.src = opciones.shift();
    avatar.append(logo);
  }
  return avatar;
}

const PESO_MEDIO = { gran: 4, internacional: 4, nacional: 3, regional: 2, local: 1, redes: 0 };

// Junta las noticias que cuentan el mismo hecho. Cada grupo queda con una nota principal
// (la del medio más grande que traiga resumen) y el resto como "otras publicaciones".
function agruparHistorias(noticias) {
  const grupos = new Map();
  noticias.forEach((noticia) => {
    const clave = noticia.historia || noticia.id;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(noticia);
  });
  return [...grupos.entries()].map(([clave, miembros]) => {
    const valor = (n) => (PESO_MEDIO[n.tamano] || 0) + (n.resumen ? 3 : 0) + (n.interes === 'prioritaria' ? 1 : 0);
    const principal = miembros.reduce((mejor, n) => (valor(n) > valor(mejor) ? n : mejor), miembros[0]);
    return {
      clave,
      principal,
      otras: miembros.filter((n) => n !== principal),
      todas: miembros,
      fecha: new Date(miembros[0].fecha), // la más reciente: las noticias ya vienen ordenadas
    };
  });
}

function coberturaDe(grupo) {
  const medios = new Set(grupo.todas.filter((n) => n.tamano !== 'redes').map((n) => n.fuente)).size;
  const redes = grupo.todas.filter((n) => n.tamano === 'redes').length;
  const partes = [];
  if (medios) partes.push(`${medios} ${medios === 1 ? 'medio' : 'medios'}`);
  if (redes) partes.push(`${redes} ${redes === 1 ? 'publicación' : 'publicaciones'} en redes`);
  return partes.join(' y ');
}

function tonosDe(grupo) {
  return ['favorable', 'neutra', 'desfavorable']
    .map((tono) => [tono, grupo.todas.filter((n) => n.tono === tono).length])
    .filter(([, cantidad]) => cantidad);
}

// Lista desplegable con los demás medios que publicaron la misma historia
function crearOtrasPublicaciones(grupo) {
  const caja = crear('div', 'historia');
  const cabecera = crear('p', 'historia-resumen');
  cabecera.append(crear('strong', '', 'Misma historia en '), coberturaDe(grupo));

  const tonos = tonosDe(grupo);
  if (tonos.length) {
    const fila = crear('span', 'historia-tonos');
    tonos.forEach(([tono, cantidad]) => {
      fila.append(
        crear('span', `etiqueta etiqueta-tono-${tono}`, `${cantidad} ${ETIQUETA_TONO[tono].toLowerCase()}${cantidad === 1 ? '' : 's'}`)
      );
    });
    cabecera.append(fila);
  }

  const lista = crear('ul', 'historia-lista');
  lista.id = `historia-${grupo.clave}`;
  lista.hidden = !state.historiasAbiertas.has(grupo.clave);
  grupo.otras.forEach((n) => {
    const item = crear('li');
    const texto = crear('span', 'historia-texto');
    const enlace = crear('a', '', n.titulo);
    enlace.href = enlaceSeguro(n.enlace);
    enlace.target = '_blank';
    enlace.rel = 'noopener noreferrer';
    const pie = crear('span', 'historia-pie');
    pie.append(crear('strong', '', n.fuente), ` · ${haceCuanto(new Date(n.fecha))}`);
    if (ETIQUETA_TONO[n.tono]) pie.append(' · ', crear('span', `tono-texto tono-texto-${n.tono}`, ETIQUETA_TONO[n.tono]));
    texto.append(enlace, pie);
    item.append(crearAvatar(n), texto);
    lista.append(item);
  });

  const cuantas = grupo.otras.length;
  const rotulo = (abierta) =>
    abierta
      ? 'Ocultar las demás publicaciones'
      : `Ver ${cuantas === 1 ? 'la otra publicación' : `las otras ${cuantas} publicaciones`}`;
  const boton = crear('button', 'boton boton-borde historia-boton', rotulo(!lista.hidden));
  boton.type = 'button';
  boton.setAttribute('aria-expanded', String(!lista.hidden));
  boton.setAttribute('aria-controls', lista.id);
  boton.addEventListener('click', () => {
    lista.hidden = !lista.hidden;
    if (lista.hidden) state.historiasAbiertas.delete(grupo.clave);
    else state.historiasAbiertas.add(grupo.clave);
    boton.textContent = rotulo(!lista.hidden);
    boton.setAttribute('aria-expanded', String(!lista.hidden));
  });

  caja.append(cabecera, boton, lista);
  return caja;
}

function crearTarjeta(noticia, grupo) {
  const fecha = new Date(noticia.fecha);
  const enlace = enlaceSeguro(noticia.enlace);
  const tarjeta = crear('article', `tarjeta ${noticia.categoria}`);

  const etiquetas = crear('div', 'etiquetas');
  etiquetas.append(
    crear('span', `etiqueta etiqueta-${noticia.categoria}`, ETIQUETA_CATEGORIA[noticia.categoria] || 'Noticia'),
    crear(
      'span',
      `etiqueta etiqueta-tamano${noticia.tamano === 'redes' ? ' etiqueta-redes' : ''}`,
      ETIQUETA_TAMANO[noticia.tamano] || ETIQUETA_TAMANO.local
    ),
    crear('span', 'etiqueta etiqueta-tema', temaDe(noticia))
  );
  if (ETIQUETA_TONO[noticia.tono]) {
    etiquetas.append(crear('span', `etiqueta etiqueta-tono-${noticia.tono}`, ETIQUETA_TONO[noticia.tono]));
  }
  if (noticia.categoria === 'coyuntura' && noticia.interes === 'prioritaria') {
    etiquetas.append(crear('span', 'etiqueta etiqueta-prioritaria', '★ Prioritaria'));
  }

  const titulo = crear('h3');
  const tituloEnlace = crear('a', '', noticia.titulo);
  tituloEnlace.href = enlace;
  tituloEnlace.target = '_blank';
  tituloEnlace.rel = 'noopener noreferrer';
  titulo.append(tituloEnlace);

  const meta = crear('p', 'meta');
  const avatar = crearAvatar(noticia);
  const metaTexto = crear('span', 'meta-texto');
  metaTexto.append(crear('strong', '', noticia.fuente), crear('span', 'meta-hora', haceCuanto(fecha)));
  meta.append(avatar, metaTexto);

  const resumen = noticia.resumen
    ? crear('p', 'resumen', noticia.resumen)
    : crear(
        'p',
        'resumen sin-texto',
        noticia.tamano === 'redes'
          ? `Publicación en ${noticia.fuente}. Ábrala para verla completa.`
          : `Titular publicado por ${noticia.fuente}. Abra la noticia original para leer el texto completo.`
      );

  const detalle = crear('div', 'detalle');
  detalle.id = `detalle-${noticia.id}`;
  detalle.hidden = !state.abiertas.has(noticia.id);
  detalle.append(crear('h4', '', 'Más detalle'));
  if (noticia.detalle) {
    detalle.append(crear('p', '', noticia.detalle));
  } else if (!noticia.cita) {
    detalle.append(
      crear(
        'p',
        '',
        noticia.tamano === 'redes'
          ? 'Solo está disponible el inicio de la publicación. Para verla completa (y saber qué cuenta la publicó) ábrala en la red social.'
          : 'Este medio no entrega un resumen ampliado. El texto completo está en la noticia original.'
      )
    );
  }
  if (noticia.cita) {
    const cita = crear('blockquote');
    cita.append(crear('strong', '', 'Mención a Uribe: '), `«${noticia.cita}»`);
    detalle.append(cita);
  }
  const ficha = crear('dl');
  ficha.append(
    crear('dt', '', 'Medio'),
    crear('dd', '', noticia.fuente),
    crear('dt', '', 'Tema'),
    crear('dd', '', temaDe(noticia)),
    ...(ETIQUETA_TONO[noticia.tono]
      ? [
          crear('dt', '', 'Tono'),
          crear('dd', '', ETIQUETA_TONO[noticia.tono] + (noticia.tono_motivo ? `: ${noticia.tono_motivo}` : '')),
        ]
      : []),
    ...(noticia.categoria === 'coyuntura' && noticia.interes
      ? [
          crear('dt', '', 'Interés'),
          crear(
            'dd',
            '',
            (noticia.interes === 'prioritaria' ? 'Prioritaria' : 'Normal') +
              (noticia.interes_motivo ? `: ${noticia.interes_motivo}` : '')
          ),
        ]
      : []),
    crear('dt', '', 'Tipo de medio'),
    crear('dd', '', ETIQUETA_TAMANO[noticia.tamano] || ETIQUETA_TAMANO.local),
    crear('dt', '', 'Publicada'),
    crear('dd', '', fmtCompleta.format(fecha))
  );
  detalle.append(ficha);

  const acciones = crear('div', 'acciones');
  const botonDetalle = crear('button', 'boton boton-borde', detalle.hidden ? 'Ver más detalle' : 'Ocultar detalle');
  botonDetalle.type = 'button';
  botonDetalle.setAttribute('aria-expanded', String(!detalle.hidden));
  botonDetalle.setAttribute('aria-controls', detalle.id);
  botonDetalle.addEventListener('click', () => {
    detalle.hidden = !detalle.hidden;
    if (detalle.hidden) state.abiertas.delete(noticia.id);
    else state.abiertas.add(noticia.id);
    botonDetalle.textContent = detalle.hidden ? 'Ver más detalle' : 'Ocultar detalle';
    botonDetalle.setAttribute('aria-expanded', String(!detalle.hidden));
  });

  const botonLeer = crear(
    'a',
    'boton boton-azul',
    noticia.tamano === 'redes' ? `Ver publicación en ${noticia.fuente} ↗` : 'Leer noticia original ↗'
  );
  botonLeer.href = enlace;
  botonLeer.target = '_blank';
  botonLeer.rel = 'noopener noreferrer';
  botonLeer.setAttribute('aria-label', `Leer noticia original en ${noticia.fuente} (se abre en otra pestaña)`);

  acciones.append(botonDetalle, botonLeer);
  tarjeta.append(etiquetas, titulo, meta, resumen, detalle, acciones);
  if (grupo && grupo.otras.length) tarjeta.append(crearOtrasPublicaciones(grupo));
  return tarjeta;
}

function renderNews() {
  updateStats();
  renderTemas();
  const filtradas = getFilteredNews();
  const historias = agruparHistorias(filtradas);
  const visibles = historias.slice(0, state.visibles);

  resultCountEl.textContent =
    historias.length === filtradas.length
      ? `${filtradas.length} ${filtradas.length === 1 ? 'noticia' : 'noticias'}`
      : `${historias.length} historias · ${filtradas.length} publicaciones`;
  newsGridEl.replaceChildren();

  // Aviso visible de que se está viendo solo una parte de las noticias
  const partes = [];
  if (state.filter !== 'all') partes.push(ETIQUETA_CATEGORIA[state.filter] || 'Coyuntura prioritaria');
  if (state.size !== 'all') partes.push(ETIQUETA_TAMANO[state.size]);
  if (state.tema !== 'all') partes.push(`tema «${state.tema}»`);
  if (state.tono !== 'all') partes.push(`menciones ${ETIQUETA_TONO[state.tono].toLowerCase()}s`);
  if (state.query) partes.push(`búsqueda «${state.query}»`);
  $('filtrosActivos').hidden = !partes.length;
  $('filtrosActivosTexto').textContent =
    `Está viendo solo: ${partes.join(' + ')} (${filtradas.length} de ${state.noticias.length} noticias).`;

  // Botón «Filtros» del celular: indica cuántos filtros hay puestos
  const puestos = [state.filter, state.size, state.tema, state.tono].filter((valor) => valor !== 'all').length;
  const abierto = $('filtrosCuerpo').classList.contains('abierto');
  $('botonFiltrosTexto').textContent =
    (abierto ? 'Ocultar filtros' : 'Filtros') + (puestos ? ` (${puestos} activo${puestos === 1 ? '' : 's'})` : '');

  if (!filtradas.length) {
    const vacio = crear('div', 'vacio');
    const hayFiltros = state.filter !== 'all' || state.size !== 'all' || state.tema !== 'all' || state.tono !== 'all' || state.query;
    vacio.append(
      crear('h3', '', state.noticias.length ? 'No hay noticias con esos filtros.' : 'Todavía no hay noticias para mostrar.'),
      crear(
        'p',
        '',
        state.noticias.length
          ? 'Pruebe con otra palabra o quite los filtros para ver todo.'
          : 'Presione «Actualizar ahora» para intentarlo de nuevo.'
      )
    );
    if (state.noticias.length && hayFiltros) {
      const quitar = crear('button', 'boton boton-azul', 'Quitar filtros y ver todas');
      quitar.type = 'button';
      quitar.addEventListener('click', quitarFiltros);
      vacio.append(quitar);
    }
    newsGridEl.append(vacio);
    botonMasEl.hidden = true;
    return;
  }

  let diaActual = '';
  visibles.forEach((grupo) => {
    if (claveDia(grupo.fecha) !== diaActual) {
      diaActual = claveDia(grupo.fecha);
      newsGridEl.append(crear('h3', 'dia-titulo', tituloDia(grupo.fecha)));
    }
    newsGridEl.append(crearTarjeta(grupo.principal, grupo));
  });

  const restantes = historias.length - visibles.length;
  botonMasEl.hidden = restantes <= 0;
  botonMasEl.textContent = `Mostrar más (quedan ${restantes} ${restantes === 1 ? 'historia' : 'historias'})`;
}

/* ------------------------------------------------------------ resumen para compartir */

// Texto listo para pegar en WhatsApp (los *asteriscos* salen como negrita)
function construirResumen() {
  const ahora = new Date();
  let delDia = state.noticias.filter((n) => claveDia(new Date(n.fecha)) === claveDia(ahora));
  let periodo = 'hoy';
  if (delDia.length < 5) {
    delDia = state.noticias.filter((n) => ahora - new Date(n.fecha) < 24 * 60 * 60 * 1000);
    periodo = 'en las últimas 24 horas';
  }

  const medios = (grupo) => grupo.todas.length;
  const ordenar = (grupos) => grupos.sort((a, b) => medios(b) - medios(a) || b.fecha - a.fecha);
  // Los enlaces de los buscadores son larguísimos: se prefiere el enlace directo de algún medio del grupo
  const enlaceCorto = (grupo) => {
    const directa = [grupo.principal, ...grupo.otras].find(
      (n) => /^https?:/.test(n.enlace || '') && !/news\.google\.|bing\.com|msn\.com/.test(n.enlace)
    );
    return directa ? directa.enlace : '';
  };
  const linea = (grupo, numero) => {
    const cuantos = grupo.todas.length;
    const tono = ETIQUETA_TONO[grupo.principal.tono] ? ` [${ETIQUETA_TONO[grupo.principal.tono]}]` : '';
    const cobertura = cuantos > 1 ? ` (${cuantos} publicaciones)` : '';
    const enlace = enlaceCorto(grupo);
    return `${numero}. ${grupo.principal.titulo} — ${grupo.principal.fuente}${cobertura}${tono}${enlace ? `\n${enlace}` : ''}`;
  };

  const menciones = delDia.filter((n) => n.categoria === 'mencion');
  const historiasMencion = ordenar(agruparHistorias(menciones));
  const coyuntura = delDia.filter((n) => n.categoria === 'coyuntura');
  const hayPrioritarias = coyuntura.some((n) => n.interes === 'prioritaria');
  const historiasCoyuntura = ordenar(
    agruparHistorias(hayPrioritarias ? coyuntura.filter((n) => n.interes === 'prioritaria') : coyuntura)
  );
  const contarTono = (tono) => menciones.filter((n) => n.tono === tono).length;
  const desfavorables = agruparHistorias(menciones.filter((n) => n.tono === 'desfavorable'));

  const texto = [
    '*Monitor de noticias · Álvaro Uribe*',
    fmtCompleta.format(ahora),
    '',
    `*Menciones a Uribe ${periodo}:* ${menciones.length} publicaciones en ${historiasMencion.length} historias`,
  ];
  if (menciones.some((n) => n.tono)) {
    texto.push(
      `Tono: ${contarTono('favorable')} favorables · ${contarTono('neutra')} neutras · ${contarTono('desfavorable')} desfavorables`
    );
  }
  if (historiasMencion.length) {
    texto.push('', '*Lo principal sobre Uribe*', ...historiasMencion.slice(0, 5).map((g, i) => linea(g, i + 1)));
  }
  if (desfavorables.length) {
    texto.push('', '*Menciones desfavorables*', ...desfavorables.slice(0, 5).map((g, i) => linea(g, i + 1)));
  }
  if (historiasCoyuntura.length) {
    texto.push('', hayPrioritarias ? '*Coyuntura prioritaria*' : '*Coyuntura nacional*', ...historiasCoyuntura.slice(0, 5).map((g, i) => linea(g, i + 1)));
  }
  if (typeof location !== 'undefined' && /^https?:/.test(location.href)) {
    texto.push('', `Ver todo: ${location.href.split('#')[0].split('?')[0]}`);
  }
  return texto.join('\n');
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch (error) {
    // Navegadores antiguos o sin permiso: se copia desde un cuadro de texto temporal
    const caja = document.createElement('textarea');
    caja.value = texto;
    caja.setAttribute('readonly', '');
    caja.style.position = 'fixed';
    caja.style.opacity = '0';
    document.body.append(caja);
    caja.select();
    let copiado = false;
    try {
      copiado = document.execCommand('copy');
    } catch (fallo) {
      copiado = false;
    }
    caja.remove();
    return copiado;
  }
}

async function compartirResumen() {
  const texto = construirResumen();
  const rotulo = $('botonResumenTexto');
  const copiado = await copiarTexto(texto);
  rotulo.textContent = copiado ? '✓ Copiado. Péguelo en WhatsApp' : 'No se pudo copiar';
  setTimeout(() => {
    rotulo.textContent = 'Copiar resumen del día';
  }, 4000);
}

function marcarActivo(selector, atributo, valor) {
  document.querySelectorAll(selector).forEach((boton) => {
    const activo = boton.dataset[atributo] === valor;
    boton.classList.toggle('activo', activo);
    boton.setAttribute('aria-pressed', String(activo));
  });
}

function quitarFiltros() {
  state.filter = 'all';
  state.size = 'all';
  state.tema = 'all';
  state.tono = 'all';
  state.query = '';
  state.visibles = POR_PAGINA;
  searchInputEl.value = '';
  limpiarBusquedaEl.hidden = true;
  marcarActivo('.filtro-btn', 'filter', 'all');
  marcarActivo('.tamano-btn', 'size', 'all');
  marcarActivo('.tono-btn', 'tono', 'all');
  renderNews();
}

function aplicarLetra(grande) {
  document.documentElement.classList.toggle('letra-grande', grande);
  botonLetraEl.setAttribute('aria-pressed', String(grande));
  botonLetraEl.lastChild.textContent = grande ? ' Letra normal' : ' Letra más grande';
  botonLetraEl.firstElementChild.textContent = grande ? 'A−' : 'A+';
}

function bindEvents() {
  document.querySelectorAll('.filtro-btn').forEach((boton) => {
    boton.addEventListener('click', () => {
      state.filter = boton.dataset.filter;
      state.visibles = POR_PAGINA;
      marcarActivo('.filtro-btn', 'filter', state.filter);
      renderNews();
    });
  });

  document.querySelectorAll('.tamano-btn').forEach((boton) => {
    boton.addEventListener('click', () => {
      state.size = boton.dataset.size;
      state.visibles = POR_PAGINA;
      marcarActivo('.tamano-btn', 'size', state.size);
      renderNews();
    });
  });

  document.querySelectorAll('.tono-btn').forEach((boton) => {
    boton.addEventListener('click', () => {
      state.tono = boton.dataset.tono;
      state.visibles = POR_PAGINA;
      marcarActivo('.tono-btn', 'tono', state.tono);
      renderNews();
    });
  });

  searchInputEl.addEventListener('input', () => {
    state.query = searchInputEl.value.trim();
    state.visibles = POR_PAGINA;
    limpiarBusquedaEl.hidden = !state.query;
    renderNews();
  });

  limpiarBusquedaEl.addEventListener('click', () => {
    searchInputEl.value = '';
    state.query = '';
    limpiarBusquedaEl.hidden = true;
    renderNews();
    searchInputEl.focus();
  });

  botonMasEl.addEventListener('click', () => {
    state.visibles += POR_PAGINA;
    renderNews();
  });

  refreshButtonEl.addEventListener('click', () => handleRefresh(true));

  $('botonFiltros').addEventListener('click', () => {
    const abierto = !$('filtrosCuerpo').classList.contains('abierto');
    $('filtrosCuerpo').classList.toggle('abierto', abierto);
    $('botonFiltros').classList.toggle('abierto', abierto);
    $('botonFiltros').setAttribute('aria-expanded', String(abierto));
    renderNews();
  });
  $('quitarFiltros').addEventListener('click', quitarFiltros);
  $('botonResumen').addEventListener('click', compartirResumen);

  botonLetraEl.addEventListener('click', () => {
    const grande = !document.documentElement.classList.contains('letra-grande');
    aplicarLetra(grande);
    try {
      localStorage.setItem(CLAVE_LETRA, grande ? '1' : '0');
    } catch (error) {
      /* sin almacenamiento: la preferencia dura solo esta visita */
    }
  });

  // Si la pestaña estuvo en segundo plano (el navegador pausa los relojes), se pone al día al volver
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.ultimaCarga >= AUTO_REFRESH_MS) handleRefresh();
  });
}

let letraGuardada = false;
try {
  letraGuardada = localStorage.getItem(CLAVE_LETRA) === '1';
} catch (error) {
  /* almacenamiento bloqueado */
}

bindEvents();
aplicarLetra(letraGuardada);
handleRefresh();
setInterval(() => handleRefresh(), AUTO_REFRESH_MS);
