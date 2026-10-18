# Lectura semanal de ActaWP, hecha por una persona

El sistema **no consulta ActaWP por su cuenta**: las condiciones de uso de Clupik prohíben el acceso automatizado sin autorización escrita. Mientras no la haya, una persona abre las páginas en su navegador, las guarda y las sube aquí. El resto (comprobar, publicar, avisar) es automático.

Los cambios de fecha, hora y sede siguen llegando solos por los avisos de Clupik. Esta lectura sirve para **confirmar contra la fuente oficial** que no se ha escapado nada y para detectar partidos nuevos.

## Cada semana (unos 10 minutos)

1. Abre cada enlace de la tabla en tu navegador y comprueba que ves el calendario.
2. Pulsa **Ctrl+S** (en Mac, **Cmd+S**). En «Formato» elige **Página web, solo HTML** y guarda con **exactamente** el nombre de la tabla.
3. En GitHub abre la carpeta `data/manual`, pulsa **Add file → Upload files**, arrastra los 9 ficheros (se sustituyen los de la semana anterior) y pulsa **Commit changes** sobre `main`.
4. Espera un par de minutos y abre la pestaña **Actions**. Si «ActaWP export» sale en verde, ya está. Si sale en rojo, abre la ejecución: el mensaje dice qué falta (por ejemplo, un fichero o una página equivocada). Corrígelo y vuelve a subir.

Guarda las páginas **justo antes de subirlas**: la fecha de la lectura que figura en `estado.html` es la de la subida.

| Fichero | Página que hay que abrir |
| --- | --- |
| `absoluto-masculino.html` | https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all |
| `alevin-mixto-a.html` | https://actawp.natacio.cat/ca/tournament/1339810/calendar/3714189/all |
| `alevin-mixto-b.html` | https://actawp.natacio.cat/ca/tournament/1339810/calendar/3714193/all |
| `cadete-masculino.html` | https://actawp.natacio.cat/ca/tournament/1339808/calendar/3714157/all |
| `infantil-mixto-a.html` | https://actawp.natacio.cat/ca/tournament/1339809/calendar/3714172/all |
| `infantil-mixto-b.html` | https://actawp.natacio.cat/ca/tournament/1339809/calendar/3714183/all |
| `juvenil-femenino.html` | https://actawp.natacio.cat/ca/tournament/1339811/calendar/3714139/all |
| `1a-div-fem-absoluta-b.html` | https://actawp.natacio.cat/ca/tournament/1339806/calendar/3713773/all |
| `juvenil-masculino.html` | https://actawp.natacio.cat/ca/tournament/1339807/calendar/3714147/all |

(`python actawp_export.py --list-manual` imprime esta misma tabla con los grupos vigentes.)

## Qué hacer con lo que aparezca

- **Partidos pendientes.** Si ActaWP lista un partido de AESE sin rival o sin fecha, no se crea evento, pero se muestra en la página de estado y en la de familias (solo como «pendiente de rival o fecha»). Cuando la FCN lo complete, llegará el aviso de Clupik o lo recogerá la siguiente lectura.
- **Fila ilegible de AESE.** Bloquea la publicación a propósito: nunca se publica un partido de AESE a medias. El mensaje de la ejecución indica el número de partido; ábrelo en ActaWP y comprueba qué le falta.
- **Aplazado o cancelado.** También bloquea hasta que alguien lo revise. El aviso de Clupik marca el evento como `[APLAZADO]` o `[CANCELADO]` sin borrarlo.

## Cuánto tiempo puede pasar sin leer

La política está en `data/freshness_policy.json`: **al día** hasta 8 días, **obsoleto** pasados 15. Si nadie sube las páginas, el calendario sigue funcionando con los avisos de Clupik, pero el sistema lo dice con claridad, solo al responsable (correo a la dirección de alertas y página `estado.html`), en lugar de aparentar que está al día. Las familias no ven ningún aviso.

Si algún día la FCN o Clupik autorizan por escrito la lectura automática, se activa con `ACTAWP_AUTOMATED_ACCESS_AUTHORIZED=yes` y se vuelve a programar el workflow; el código del cliente educado se conserva en `actawp_fetch.py`.
