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

const ETIQUETA_CATEGORIA = {
  coyuntura: 'Coyuntura nacional',
  mencion: 'Mención al presidente Uribe',
};

const state = {
  filter: 'all',
  size: 'all',
  tema: 'all',
  relevancia: 'all',
  query: '',
  visibles: POR_PAGINA,
  noticias: [],
  abiertas: new Set(),
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
      (state.filter === 'all' || noticia.categoria === state.filter) &&
      (state.size === 'all' || noticia.tamano === state.size) &&
      (state.tema === 'all' || temaDe(noticia) === state.tema) &&
      (state.relevancia === 'all' || (noticia.relevancia || 'media') === state.relevancia) &&
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

  document.querySelectorAll('[data-conteo]').forEach((nodo) => {
    const clave = nodo.dataset.conteo;
    if (clave === 'all') nodo.textContent = todas.length;
    else if (clave === 'coyuntura' || clave === 'mencion') nodo.textContent = contar('categoria', clave);
    else if (clave.startsWith('rel-')) nodo.textContent = contar('relevancia', clave.slice(4));
    else nodo.textContent = contar('tamano', clave);
  });
}

function crearTarjeta(noticia) {
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
  if (noticia.relevancia === 'alta') etiquetas.append(crear('span', 'etiqueta etiqueta-alta', '★ Relevancia alta'));

  const titulo = crear('h3');
  const tituloEnlace = crear('a', '', noticia.titulo);
  tituloEnlace.href = enlace;
  tituloEnlace.target = '_blank';
  tituloEnlace.rel = 'noopener noreferrer';
  titulo.append(tituloEnlace);

  const meta = crear('p', 'meta');
  const inicial = (noticia.fuente.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/) || ['•'])[0].toUpperCase();
  const avatar = crear('span', 'avatar', inicial);
  avatar.setAttribute('aria-hidden', 'true');
  // Logo del medio (su ícono oficial). Si no carga, queda la inicial.
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
    crear('dt', '', 'Relevancia'),
    crear(
      'dd',
      '',
      `${{ alta: 'Alta', media: 'Media', baja: 'Baja' }[noticia.relevancia] || 'Media'}` +
        (noticia.cobertura > 1 ? ` · ${noticia.cobertura} medios publicaron esta historia` : '')
    ),
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
  return tarjeta;
}

function renderNews() {
  updateStats();
  renderTemas();
  const filtradas = getFilteredNews();
  const visibles = filtradas.slice(0, state.visibles);

  resultCountEl.textContent =
    filtradas.length === 1 ? '1 noticia encontrada' : `${filtradas.length} noticias encontradas`;
  newsGridEl.replaceChildren();

  // Aviso visible de que se está viendo solo una parte de las noticias
  const partes = [];
  if (state.filter !== 'all') partes.push(ETIQUETA_CATEGORIA[state.filter]);
  if (state.size !== 'all') partes.push(ETIQUETA_TAMANO[state.size]);
  if (state.tema !== 'all') partes.push(`tema «${state.tema}»`);
  if (state.relevancia !== 'all') partes.push(`relevancia ${state.relevancia}`);
  if (state.query) partes.push(`búsqueda «${state.query}»`);
  $('filtrosActivos').hidden = !partes.length;
  $('filtrosActivosTexto').textContent =
    `Está viendo solo: ${partes.join(' + ')} (${filtradas.length} de ${state.noticias.length} noticias).`;

  if (!filtradas.length) {
    const vacio = crear('div', 'vacio');
    const hayFiltros = state.filter !== 'all' || state.size !== 'all' || state.tema !== 'all' || state.relevancia !== 'all' || state.query;
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
  visibles.forEach((noticia) => {
    const fecha = new Date(noticia.fecha);
    if (claveDia(fecha) !== diaActual) {
      diaActual = claveDia(fecha);
      newsGridEl.append(crear('h3', 'dia-titulo', tituloDia(fecha)));
    }
    newsGridEl.append(crearTarjeta(noticia));
  });

  const restantes = filtradas.length - visibles.length;
  botonMasEl.hidden = restantes <= 0;
  botonMasEl.textContent = `Mostrar más noticias (quedan ${restantes})`;
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
  state.relevancia = 'all';
  state.query = '';
  state.visibles = POR_PAGINA;
  searchInputEl.value = '';
  limpiarBusquedaEl.hidden = true;
  marcarActivo('.filtro-btn', 'filter', 'all');
  marcarActivo('.tamano-btn', 'size', 'all');
  marcarActivo('.rel-btn', 'rel', 'all');
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

  document.querySelectorAll('.rel-btn').forEach((boton) => {
    boton.addEventListener('click', () => {
      state.relevancia = boton.dataset.rel;
      state.visibles = POR_PAGINA;
      marcarActivo('.rel-btn', 'rel', state.relevancia);
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
  $('quitarFiltros').addEventListener('click', quitarFiltros);

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
