#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor local del Monitor de Noticias.

Uso:
    python3 server.py            -> abre el sitio en http://localhost:8000
    python3 server.py 8080       -> usa otro puerto
    python3 server.py --abrir    -> además abre el navegador
    python3 server.py --respaldo -> solo descarga noticias y actualiza data/respaldo.json

Sirve los archivos del sitio y expone /api/noticias, que lee feeds RSS reales
(los navegadores no pueden leerlos directamente por restricciones CORS).
Solo usa la biblioteca estándar de Python 3.
"""

import hashlib
import html
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
RUTA_RESPALDO = os.path.join(BASE, "data", "respaldo.json")
RUTA_MEDIOS = os.path.join(BASE, "data", "medios.json")

ACTUALIZAR_CADA_SEGUNDOS = 45 * 60   # actualización automática del servidor
CACHE_SEGUNDOS = 10 * 60        # entre visitas normales
MIN_ENTRE_FORZADOS = 45         # el botón "Actualizar" no golpea los feeds más seguido que esto
TIEMPO_ESPERA = 12
DIAS_MENCIONES = 10
DIAS_COYUNTURA = 3
MAX_POR_CATEGORIA = 150
MAX_REDES = 60                  # publicaciones de redes sociales (cupo aparte)
MIN_NOTICIAS_VALIDAS = 8        # con menos que esto se considera que la carga falló

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _q(texto):
    return urllib.parse.quote(texto)


GOOGLE = "https://news.google.com/rss/search?q={}&hl=es-419&gl=CO&ceid=CO:es-419"
BING = "https://www.bing.com/news/search?q={}&format=rss&cc=CO&setlang=es"

# tipo: directo | google | bing      seccion: mencion | coyuntura
FEEDS = [
    # --- Búsquedas de menciones (dan alcance a medios pequeños y regionales)
    {"nombre": "Google Noticias: Álvaro Uribe", "tipo": "google", "seccion": "mencion",
     "url": GOOGLE.format(_q('"Álvaro Uribe" when:10d'))},
    {"nombre": "Google Noticias: Uribe Vélez", "tipo": "google", "seccion": "mencion",
     "url": GOOGLE.format(_q('"Uribe Vélez" OR "expresidente Uribe" when:10d'))},
    {"nombre": "Bing Noticias: Álvaro Uribe", "tipo": "bing", "seccion": "mencion",
     "url": BING.format(_q('"Álvaro Uribe"'))},
    {"nombre": "Bing Noticias: expresidente Uribe", "tipo": "bing", "seccion": "mencion",
     "url": BING.format(_q('"expresidente Uribe"'))},
    {"nombre": "Bing Noticias: Uribe Vélez", "tipo": "bing", "seccion": "mencion",
     "url": BING.format(_q('"Uribe Vélez"'))},
    # --- Redes sociales (solo lo que Google Noticias alcanza a indexar; X no aparece)
    {"nombre": "Facebook (vía Google Noticias)", "tipo": "google", "seccion": "mencion",
     "url": GOOGLE.format(_q('"Álvaro Uribe" site:facebook.com when:10d'))},
    {"nombre": "Instagram (vía Google Noticias)", "tipo": "google", "seccion": "mencion",
     "url": GOOGLE.format(_q('"Álvaro Uribe" site:instagram.com when:10d'))},
    # --- Coyuntura nacional
    {"nombre": "Google Noticias: Colombia", "tipo": "google", "seccion": "coyuntura",
     "url": "https://news.google.com/rss/headlines/section/topic/NATION?hl=es-419&gl=CO&ceid=CO:es-419"},
    {"nombre": "El Tiempo", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.eltiempo.com/rss/politica.xml"},
    {"nombre": "El Tiempo", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.eltiempo.com/rss/colombia.xml"},
    {"nombre": "El Tiempo", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.eltiempo.com/rss/justicia.xml"},
    {"nombre": "Semana", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.semana.com/arc/outboundfeeds/rss/category/politica/?outputType=xml"},
    {"nombre": "Semana", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.semana.com/arc/outboundfeeds/rss/category/nacion/?outputType=xml"},
    {"nombre": "Infobae", "tipo": "directo", "seccion": "coyuntura", "filtrar": True,
     "url": "https://www.infobae.com/arc/outboundfeeds/rss/category/colombia/?outputType=xml"},
    {"nombre": "El Colombiano", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.elcolombiano.com/rss/colombia.xml"},
    {"nombre": "La República", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.larepublica.co/rss/"},
    {"nombre": "Portafolio", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.portafolio.co/rss/economia.xml"},
    {"nombre": "El Nuevo Siglo", "tipo": "directo", "seccion": "coyuntura", "filtrar": True,
     "url": "https://www.elnuevosiglo.com.co/rss.xml"},
    {"nombre": "La Silla Vacía", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.lasillavacia.com/feed/"},
    {"nombre": "Kienyke", "tipo": "directo", "seccion": "coyuntura", "filtrar": True,
     "url": "https://www.kienyke.com/feed"},
    {"nombre": "El Heraldo", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.elheraldo.co/arc/outboundfeeds/rss/category/politica/?outputType=xml"},
    {"nombre": "El Heraldo", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.elheraldo.co/arc/outboundfeeds/rss/category/colombia/?outputType=xml"},
    {"nombre": "El Universal", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.eluniversal.com.co/arc/outboundfeeds/rss/category/colombia/?outputType=xml"},
    {"nombre": "Vanguardia", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.vanguardia.com/arc/outboundfeeds/rss/category/politica/?outputType=xml"},
    {"nombre": "Vanguardia", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.vanguardia.com/arc/outboundfeeds/rss/category/colombia/?outputType=xml"},
    {"nombre": "El País Cali", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.elpais.com.co/arc/outboundfeeds/rss/category/politica/?outputType=xml"},
    {"nombre": "La Patria", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.lapatria.com/rss.xml"},
    {"nombre": "La Opinión", "tipo": "directo", "seccion": "coyuntura",
     "url": "https://www.laopinion.co/rss.xml"},
]

# Para comprobar que la mención se ve en el texto mostrado (y no es otro Uribe)
RE_OTRO_URIBE = re.compile(r"miguel\s+uribe(?:\s+(?:turbay|londo[nñ]o))?|uribe\s+turbay|uribe\s+londo[nñ]o", re.IGNORECASE)
RE_URIBE_VISIBLE = re.compile(r"\buribe\b|\buribis", re.IGNORECASE)

RE_MENCION = re.compile(
    r"[aá]lvaro\s+uribe|uribe\s+v[eé]lez|ex\s?presidente\s+(?:[aá]lvaro\s+)?uribe|"
    r"presidente\s+uribe|senador\s+uribe",
    re.IGNORECASE,
)

# Secciones que no son coyuntura nacional (deportes, farándula, etc.)
RE_RUTA_EXCLUIDA = re.compile(
    r"/(deportes?|futbol|entretenimiento|farandula|gente|cultura|tecnologia|tecno|tendencias|"
    r"vida|turismo|horoscopo|loterias?|virales?|autos|motor|cine|musica|television|"
    r"globoeconomia|mundo|internacional|america|estados-unidos|perrosygatos|recetas|"
    r"salud|mascotas|juegos|ocio|estilo-de-vida|cromos|contenido-patrocinado|brandstudio)/",
    re.IGNORECASE,
)
RE_TITULO_EXCLUIDO = re.compile(
    r"loter[ií]a|hor[oó]scopo|baloto|chance|sorteo|resultados? de(l)? (super )?astro|"
    r"pico y placa|liga betplay|dimayor|selecci[oó]n colombia|presentadora?|actriz|actor\b|cantante|"
    r"reality|influencer|masterchef|desaf[ií]o|novela|reina de belleza|modelo\b|far[aá]ndula|"
    r"receta|truco|netflix|se[nñ]orita colombia|reinado|coronaci[oó]n|precio del gramo|oro en colombia|placa\b|leo radio|concierto|hor[aá]rio de|d[oó]lar hoy|precio del d[oó]lar hoy",
    re.IGNORECASE,
)


# Los feeds generales (marcados con "filtrar") solo aportan notas con estos temas
RE_TEMA_NACIONAL = re.compile(
    r"gobierno|president|congreso|senad|c[aá]mara|ministr|fiscal|procurad|contralor|corte|"
    r"reforma|ley\b|decreto|elecci|partido|pacto hist[oó]rico|centro democr[aá]tico|"
    r"eln|farc|disidencia|clan del golfo|paz\b|seguridad|orden p[uú]blico|ej[eé]rcito|polic[ií]a|"
    r"econom[ií]a|inflaci[oó]n|impuesto|iva\b|tributari|presupuesto|salario m[ií]nimo|dane|"
    r"banco de la rep[uú]blica|petro|de la espriella|uribe|alcald|gobernador|paro\b|protesta|"
    r"salud|eps|pensi|energ[ií]a|gas\b|ecopetrol|venezuela|frontera|narcotr[aá]fico|justicia|jep",
    re.IGNORECASE,
)


# ------------------------------------------------------------------ utilidades

def sin_tildes(texto):
    return "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn")


def normalizar(texto):
    return re.sub(r"\s+", " ", sin_tildes(texto or "").lower()).strip()


RE_PROMO = re.compile(
    r"(?:L ?eer m[aá]s|Le puede interesar|Tambi[eé]n le puede interesar|Le recomendamos|Lea(?: tambi[eé]n| adem[aá]s| aqu[ií])?|"
    r"Vea tambi[eé]n|Puede leer|En contexto|Siga leyendo|Otras noticias)\s*:\s*[^.?!]*[.?!]",
    re.IGNORECASE,
)
RE_FIRMA = re.compile(r"^\S+ \w{3}, \d{2}/\d{2}/\d{4} - \d{2}:\d{2}\s*\.?\s*(?:Cr[eé]ditos?:[^.]*\.)?\s*", re.IGNORECASE)


def limpiar(texto):
    """Quita etiquetas HTML y entidades; deja texto plano en una línea."""
    if not texto:
        return ""
    texto = html.unescape(texto)
    texto = re.sub(r"(?is)<(script|style|figure|figcaption|iframe)[^>]*>.*?</\1>", " ", texto)
    texto = re.sub(r"(?i)</(p|div|h[1-6]|li)>|<br\s*/?>", ". ", texto)
    texto = re.sub(r"<[^>]+>", " ", texto)
    texto = html.unescape(texto).replace("\xa0", " ")
    texto = re.sub(r"https?://\S+", " ", texto)
    texto = re.sub(r"\s+", " ", texto)
    texto = re.sub(r"\s+([.,;:!?])", r"\1", texto)
    texto = re.sub(r"([.!?:;,])(\s*\.)+", r"\1", texto)
    texto = RE_PROMO.sub("", texto)
    return re.sub(r"\s+", " ", texto).strip()


def quitar_encabezado(texto, titulo):
    """Algunos feeds repiten el titular y la firma al inicio del texto."""
    if texto.startswith(titulo):
        texto = texto[len(titulo):].lstrip(" .")
    return RE_FIRMA.sub("", texto).strip()


def recortar(texto, maximo):
    """Recorta sin partir palabras; prefiere terminar en punto."""
    if len(texto) <= maximo:
        return texto
    trozo = texto[:maximo]
    punto = max(trozo.rfind(". "), trozo.rfind("? "), trozo.rfind("! "))
    if punto > maximo * 0.55:
        return trozo[:punto + 1]
    return trozo[:trozo.rfind(" ")].rstrip(",;: ") + "…"


def a_fecha(texto):
    if not texto:
        return None
    texto = texto.strip()
    try:
        fecha = parsedate_to_datetime(texto)
    except Exception:
        try:
            fecha = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        except Exception:
            return None
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=timezone.utc)
    return fecha.astimezone(timezone.utc)


def dominio(url):
    try:
        return urllib.parse.urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return ""


def cargar_medios():
    with open(RUTA_MEDIOS, encoding="utf-8") as f:
        datos = json.load(f)
    return {k: [normalizar(x) for x in v] for k, v in datos.items() if isinstance(v, list)}


def clasificar_tamano(fuente, dom, medios):
    nombre = normalizar(fuente)
    for clave in medios.get("redes", []):
        if nombre == clave or dom == clave or dom == clave + ".com" or dom.endswith("." + clave + ".com"):
            return "redes"
    etiqueta = nombre + " " + dom
    for tamano in ("regional", "nacional", "gran"):
        for clave in medios.get(tamano, []):
            if clave in etiqueta:
                return tamano
    return "local"


def hijo(item, *nombres):
    """Texto del primer hijo cuyo nombre local coincide (ignora namespaces)."""
    for elem in item:
        local = elem.tag.rsplit("}", 1)[-1].lower()
        if local in nombres:
            return elem
    return None


def texto_hijo(item, *nombres):
    elem = hijo(item, *nombres)
    return (elem.text or "").strip() if elem is not None else ""


def frase_con_mencion(texto):
    m = RE_MENCION.search(texto)
    if not m:
        return ""
    inicio = max(texto.rfind(". ", 0, m.start()) + 2, 0) if ". " in texto[:m.start()] else 0
    fin = texto.find(". ", m.end())
    fin = len(texto) if fin == -1 else fin + 1
    return recortar(texto[inicio:fin].strip(), 380)


# ------------------------------------------------------------------ descarga

def descargar(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "es-CO,es;q=0.9",
    })
    for intento in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=TIEMPO_ESPERA) as resp:
                return resp.read()
        except Exception:
            if intento == 2:
                raise
            time.sleep(1.2)


def leer_feed(feed, medios):
    crudo = descargar(feed["url"])
    try:
        raiz = ET.fromstring(crudo)
    except ET.ParseError:
        # Algunos feeds traen caracteres de control o '&' sueltos
        texto = crudo.decode("utf-8", "replace")
        texto = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", texto)
        texto = re.sub(r"&(?!#?\w+;)", "&amp;", texto)
        raiz = ET.fromstring(texto.encode("utf-8"))

    noticias = []
    for item in raiz.iter("item"):
        titulo = limpiar(texto_hijo(item, "title")).rstrip(".")
        enlace = texto_hijo(item, "link")
        fecha = a_fecha(texto_hijo(item, "pubdate", "date", "published"))
        if not titulo or not enlace.startswith("http") or fecha is None:
            continue

        descripcion = quitar_encabezado(limpiar(texto_hijo(item, "description")), titulo)
        contenido = quitar_encabezado(limpiar(texto_hijo(item, "encoded")), titulo)
        fuente, dom = feed["nombre"], dominio(enlace)

        if feed["tipo"] == "google":
            origen = hijo(item, "source")
            if origen is not None and (origen.text or "").strip():
                fuente = origen.text.strip()
                dom = dominio(origen.get("url", ""))
            descripcion = ""   # Google solo repite el titular
        elif feed["tipo"] == "bing":
            fuente = re.sub(r"\s+(on|en)\s+MSN$", "", texto_hijo(item, "source"), flags=re.I) or "Bing Noticias"
            real = urllib.parse.parse_qs(urllib.parse.urlparse(enlace).query).get("url")
            if real and real[0].startswith("http"):
                enlace = real[0]
            dom = "" if "msn.com" in dominio(enlace) else dominio(enlace)

        # Los buscadores añaden " - Medio" al final del titular
        sufijo = " - " + normalizar(fuente)
        if normalizar(titulo).endswith(sufijo) and len(titulo) > len(sufijo) + 8:
            titulo = titulo[: titulo.lower().rfind(" - " + fuente.lower()[:6])].strip() or titulo
        titulo = re.sub(r"\.? Fotos?: [^.]{3,60}$", "", titulo)

        etiqueta = normalizar(fuente) + " " + dom
        if any(x in etiqueta for x in medios.get("ignorar", [])):
            continue
        if descripcion and normalizar(descripcion) == normalizar(titulo):
            descripcion = ""

        completo = " ".join(x for x in (titulo, descripcion, contenido) if x)
        es_mencion = feed["seccion"] == "mencion" or bool(RE_MENCION.search(completo))
        if not es_mencion and (RE_RUTA_EXCLUIDA.search(enlace) or RE_TITULO_EXCLUIDO.search(titulo)):
            continue
        if not es_mencion and feed.get("filtrar") and not RE_TEMA_NACIONAL.search(titulo + " " + descripcion):
            continue

        tamano = clasificar_tamano(fuente, dom, medios)
        if tamano == "redes":
            # Google entrega el texto de la publicación (cortado) como titular
            texto = re.sub(r"^(?:S[ií]guenos en \w+ @\S+|#\w+\s+[l|])\s*", "", titulo).strip()
            titulo = recortar(texto, 120)
            descripcion = texto.rstrip(" .…") + "…" if len(texto) > len(titulo) else ""
            contenido = ""

        base = descripcion or contenido
        resumen = recortar(base, 280 if tamano == "redes" else 240)
        largo = contenido if len(contenido) > len(descripcion) else descripcion
        detalle = recortar(largo, 750) if len(largo) > len(resumen) + 40 else ""
        cita = ""
        if es_mencion and not RE_MENCION.search(titulo + " " + resumen):
            cita = frase_con_mencion(" ".join(x for x in (descripcion, contenido) if x))

        if es_mencion:
            # Solo cuenta como mención si el nombre se ve en lo que mostramos. Los buscadores
            # devuelven resultados donde Uribe aparece en una parte del texto que no entregan.
            visible = RE_OTRO_URIBE.sub(" ", " ".join((titulo, resumen, detalle, cita)))
            if not RE_URIBE_VISIBLE.search(visible):
                if feed["seccion"] == "mencion":
                    continue
                es_mencion = False

        clave = re.sub(r"[^a-z0-9]", "", normalizar(titulo))[:90]
        noticias.append({
            "id": hashlib.md5(clave.encode("utf-8")).hexdigest()[:12],
            "titulo": titulo,
            "resumen": resumen,
            "detalle": detalle,
            "cita": cita,
            "enlace": enlace,
            "fuente": re.sub(r"\s+", " ", fuente)[:60],
            "fecha": fecha.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "categoria": "mencion" if es_mencion else "coyuntura",
            "tamano": tamano,
            "_calidad": (2 if feed["tipo"] == "directo" else 1 if feed["tipo"] == "bing" else 0)
                        + (2 if resumen else 0),
        })
    return noticias


def recolectar():
    """Lee todos los feeds en paralelo. Devuelve (noticias, estado_de_fuentes)."""
    medios = cargar_medios()

    def intento(feed):
        try:
            return feed, leer_feed(feed, medios), None
        except Exception as error:   # un feed caído no debe tumbar el resto
            return feed, [], str(error)[:120]

    with ThreadPoolExecutor(max_workers=12) as pool:
        resultados = list(pool.map(intento, FEEDS))

    ahora = datetime.now(timezone.utc)
    limites = {
        "mencion": ahora - timedelta(days=DIAS_MENCIONES),
        "coyuntura": ahora - timedelta(days=DIAS_COYUNTURA),
    }
    unicas, estado = {}, {}
    for feed, noticias, error in resultados:
        e = estado.setdefault(feed["nombre"], {"nombre": feed["nombre"], "ok": False, "cantidad": 0})
        e["ok"] = e["ok"] or error is None
        e["cantidad"] += len(noticias)
        for n in noticias:
            fecha = a_fecha(n["fecha"])
            if fecha > ahora + timedelta(hours=1) or fecha < limites[n["categoria"]]:
                continue
            previa = unicas.get(n["id"])
            if previa is None:
                unicas[n["id"]] = n
                continue
            # Misma noticia por dos vías: queda la versión con mejor resumen
            mejor, otra = (n, previa) if n["_calidad"] > previa["_calidad"] else (previa, n)
            if otra["categoria"] == "mencion":
                mejor["categoria"] = "mencion"
                mejor["cita"] = mejor["cita"] or otra["cita"]
            if mejor["tamano"] == "local" and otra["tamano"] not in ("local", "redes"):
                mejor["tamano"] = otra["tamano"]
            unicas[n["id"]] = mejor

    ordenadas = sorted(unicas.values(), key=lambda n: n["fecha"], reverse=True)
    final, cuenta = [], {"mencion": 0, "coyuntura": 0, "redes": 0}
    for n in ordenadas:
        cupo = "redes" if n["tamano"] == "redes" else n["categoria"]
        if cuenta[cupo] >= (MAX_REDES if cupo == "redes" else MAX_POR_CATEGORIA):
            continue
        cuenta[cupo] += 1
        n.pop("_calidad", None)
        final.append(n)
    return final, list(estado.values())


# ------------------------------------------------------------------ caché y respaldo

_cache = {"datos": None, "momento": 0.0}
_candado = threading.Lock()


def leer_respaldo():
    try:
        with open(RUTA_RESPALDO, encoding="utf-8") as f:
            datos = json.load(f)
        datos["origen"] = "respaldo"
        return datos
    except Exception:
        return None


def guardar_respaldo(datos):
    os.makedirs(os.path.dirname(RUTA_RESPALDO), exist_ok=True)
    temporal = RUTA_RESPALDO + ".tmp"
    with open(temporal, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=1)
    os.replace(temporal, RUTA_RESPALDO)


def obtener_noticias(forzar=False):
    with _candado:
        edad = time.time() - _cache["momento"]
        if _cache["datos"] and edad < (MIN_ENTRE_FORZADOS if forzar else CACHE_SEGUNDOS):
            return _cache["datos"]

        noticias, fuentes = [], []
        try:
            noticias, fuentes = recolectar()
        except Exception as error:
            print("  ! Error leyendo feeds:", error)

        if len(noticias) >= MIN_NOTICIAS_VALIDAS:
            datos = {
                "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "origen": "vivo",
                "fuentes": fuentes,
                "noticias": noticias,
            }
            _cache.update(datos=datos, momento=time.time())
            try:
                guardar_respaldo(datos)
            except OSError as error:
                print("  ! No se pudo guardar el respaldo:", error)
            activas = sum(1 for f in fuentes if f["ok"])
            print("  ✓ {} noticias reales de {}/{} fuentes ({})".format(
                len(noticias), activas, len(fuentes), time.strftime("%H:%M:%S")))
            return datos

        print("  ! Feeds sin respuesta; se sirve la copia guardada.")
        return _cache["datos"] and dict(_cache["datos"], origen="respaldo") or leer_respaldo() or {
            "generado": None, "origen": "vacio", "fuentes": fuentes, "noticias": []}


# ------------------------------------------------------------------ servidor

class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    def do_GET(self):
        ruta = urllib.parse.urlparse(self.path)
        if ruta.path.rstrip("/") == "/api/noticias":
            forzar = "forzar" in urllib.parse.parse_qs(ruta.query)
            cuerpo = json.dumps(obtener_noticias(forzar), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(cuerpo)
            return
        super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, formato, *args):
        pass   # consola limpia durante la presentación


def actualizar_en_ciclo():
    """Descarga noticias al iniciar y luego cada 45 minutos, haya o no una página abierta."""
    while True:
        try:
            obtener_noticias(True)
        except Exception as error:
            print("  ! Actualización automática falló:", error)
        time.sleep(ACTUALIZAR_CADA_SEGUNDOS)


def main():
    argumentos = sys.argv[1:]
    if "--respaldo" in argumentos:
        datos = obtener_noticias(True)
        print("Respaldo: {} noticias ({})".format(len(datos["noticias"]), datos["origen"]))
        return

    puerto = next((int(a) for a in argumentos if a.isdigit()), 8000)
    servidor = None
    for candidato in range(puerto, puerto + 10):
        try:
            servidor = ThreadingHTTPServer(("127.0.0.1", candidato), Manejador)
            puerto = candidato
            break
        except OSError:
            continue
    if servidor is None:
        sys.exit("No hay puertos libres entre {} y {}.".format(puerto, puerto + 9))

    direccion = "http://localhost:{}".format(puerto)
    print("\n  Monitor de noticias listo en  {}\n  (Ctrl + C para detenerlo)\n".format(direccion))
    threading.Thread(target=actualizar_en_ciclo, daemon=True).start()
    if "--abrir" in argumentos:
        threading.Timer(0.8, webbrowser.open, args=(direccion,)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\n  Servidor detenido.")


if __name__ == "__main__":
    main()
