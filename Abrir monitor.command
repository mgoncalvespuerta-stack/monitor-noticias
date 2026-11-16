#!/bin/bash
# Doble clic para iniciar el monitor de noticias y abrirlo en el navegador.
cd "$(dirname "$0")" || exit 1
python3 server.py --abrir
