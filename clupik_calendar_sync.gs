const CLUPIK_REMITENTE = 'no-reply@clupik.com';

const HORAS_BUSQUEDA_INICIAL = 24;

// Calendario central AESE Waterpolo-Partidos

const CALENDAR_ID = '68af70845551fc729e20ff0ff1ca9f69bbbadade7031e6b90ace51fbcd279c7f@group.calendar.google.com';

// ======================================================

// FUNCIÓN PRINCIPAL

// ======================================================

function procesarPartidosAESE() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return procesarPartidosAESESinBloqueo_();
  } finally {
    lock.releaseLock();
  }
}

function procesarPartidosAESESinBloqueo_() {

  const calendario = CalendarApp.getCalendarById(CALENDAR_ID);

  const propiedades = PropertiesService.getScriptProperties();

  if (!calendario) {

    throw new Error(

      'No se pudo acceder al calendario AESE Waterpolo-Partidos.'

    );

  }

  let ultimaEjecucion =

    propiedades.getProperty('ULTIMA_EJECUCION');

  let desde;

  if (ultimaEjecucion) {

    desde = new Date(ultimaEjecucion);

  } else {

    desde = new Date(

      Date.now() -

      HORAS_BUSQUEDA_INICIAL * 60 * 60 * 1000

    );

  }

  const ahora = new Date();

  Logger.log(

    'Buscando correos desde: ' +

    desde.toLocaleString()

  );

  // ====================================================

  // BUSCAR CORREOS DE CLUPIK

  // ====================================================

  const fechaGmail = Utilities.formatDate(

    desde,

    Session.getScriptTimeZone(),

    'yyyy/MM/dd'

  );

  const consulta =

    'from:' +

    CLUPIK_REMITENTE +

    ' after:' +

    fechaGmail;

  const hilos = GmailApp.search(

    consulta,

    0,

    100

  );

  Logger.log(

    'Hilos encontrados: ' +

    hilos.length

  );

  let procesados = 0;

  let errores = 0;

  // ====================================================

  // PROCESAR MENSAJES

  // ====================================================

  for (const hilo of hilos) {

    const mensajes = hilo.getMessages();

    for (const mensaje of mensajes) {

      const fechaMensaje =

        mensaje.getDate();

      if (

        fechaMensaje.getTime() <=

        desde.getTime()

      ) {

        continue;

      }

      const remitente =

        mensaje.getFrom().toLowerCase();

      if (

        remitente.indexOf(

          CLUPIK_REMITENTE.toLowerCase()

        ) === -1

      ) {

        continue;

      }

      try {

        procesarMensajeAESE_(

          mensaje,

          calendario

        );

        procesados++;

      } catch (error) {

        errores++;

        Logger.log(

          'ERROR procesando "' +

          mensaje.getSubject() +

          '": ' +

          error.message

        );

      }

    }

  }

  // ====================================================

  // GUARDAR FECHA DE EJECUCIÓN

  // ====================================================

  if (errores) throw new Error('Clupik incompleto: se conserva ULTIMA_EJECUCION para reintentar');

  propiedades.setProperty(

    'ULTIMA_EJECUCION',

    ahora.toISOString()

  );

  Logger.log('--------------------------------');

  Logger.log(

    'Partidos procesados: ' +

    procesados

  );

  Logger.log(

    'Errores: ' +

    errores

  );

  Logger.log(

    'Última ejecución guardada: ' +

    ahora.toLocaleString()

  );

}

// ======================================================

// PROCESAR UN MENSAJE

// ======================================================

function procesarMensajeAESE_(

  mensaje,

  calendario

) {

  const html = mensaje.getBody();

  // ====================================================

  // 1. ID ÚNICO CLUPIK

  // ====================================================

  const enlaces = [

    ...html.matchAll(

      /href=["']([^"']+)["']/gi

    )

  ];

  let matchId = null;

  let matchUrl = null;

  for (const enlace of enlaces) {

    let url = enlace[1];

    for (let i = 0; i < 3; i++) {

      try {

        url = decodeURIComponent(url);

      } catch (e) {

        break;

      }

    }

    const encontrado =

      url.match(

        /\/match\/(\d+)\/results/i

      );

    if (encontrado) {

      matchId = encontrado[1];

      matchUrl = url;

      break;

    }

  }

  if (!matchId) {

    throw new Error(

      'No se encontró ID de partido Clupik.'

    );

  }

  // ====================================================

  // ActaWP owns all matches in the validated published snapshot. Never create a second event.
  const source = matchUrl.match(/\/tournament\/(\d+)\/match\/(\d+)\/results/i);
  if (!source) throw new Error('Torneo Clupik no identificable; revisión requerida');
  const managed = loadActaWPSnapshot_().find(m => String(m.tournament_id) === source[1] && String(m.match_id) === matchId);
  if (managed) {
    const notice = mensaje.getSubject() + ' ' + html.replace(/<[^>]+>/g, ' ');
    if (/\b(ajornat|aplazado|cancelado|cancel·lat|anul·lat|suspès)\b/i.test(notice)) {
      throw new Error('Aviso Clupik de cancelación/aplazamiento: contrastar origen antes de modificar ' + source[1] + ':' + matchId);
    }
    if (!findActaWPEvent_(calendario, managed, new Date(managed.start))) {
      throw new Error('Partido gestionado por ActaWP sin evento vinculado: ' + source[1] + ':' + matchId);
    }
    Logger.log('Partido gestionado por ActaWP; Clupik no crea ni reescribe: ' + source[1] + ':' + matchId);
    return;
  }

  // 2. EXTRAER BLOQUES

  // ====================================================

  const bloques = [];

  const regex =

    /<(?:td|div|p|h[1-6])[^>]*>([\s\S]*?)<\/(?:td|div|p|h[1-6])>/gi;

  let resultado;

  while (

    (resultado = regex.exec(html)) !== null

  ) {

    let texto = resultado[1]

      .replace(

        /\<style[\s\S]*?<\/style>/gi,

        ''

      )

      .replace(

        /\<script[\s\S]*?<\/script>/gi,

        ''

      )

      .replace(

        /<[^>]+>/g,

        ' '

      )

      .replace(

        /&nbsp;/gi,

        ' '

      )

      .replace(

        /&amp;/gi,

        '&'

      )

      .replace(

        /\s+/g,

        ' '

      )

      .trim();

    if (

      texto.length > 2 &&

      texto.length < 300

    ) {

      bloques.push(texto);

    }

  }

  // ====================================================

  // 3. LOCALIZAR DATOS

  // ====================================================

  const indiceCompeticion =

    bloques.findIndex(b =>

      b.includes(

        'Federació Catalana de Natació'

      )

    );

  const indiceHora =

    bloques.findIndex(b =>

      /^\d{1,2}:\d{2}$/.test(b)

    );

  const indiceFecha =

    bloques.findIndex(b =>

      /^\d{2}\/\d{2}\/\d{4}$/.test(b)

    );

  if (

    indiceCompeticion === -1 ||

    indiceHora === -1 ||

    indiceFecha === -1

  ) {

    throw new Error(

      'No se pudieron localizar los datos principales del partido.'

    );

  }

  const competicion =

    bloques[indiceCompeticion];

  const categoria =

    obtenerCategoriaCorta_(competicion);

  const hora =

    bloques[indiceHora];

  const equipoLocal =

    bloques[indiceHora + 1];

  const jornada =

    bloques[indiceHora + 2];

  // ====================================================

  // 4. FECHA Y HORA

  // ====================================================

  const fechaTexto =

    bloques[indiceFecha];

  const partesFecha =

    fechaTexto.split('/').map(Number);

  // Clupik envía las fechas en formato DD/MM/YYYY.

  const dia = partesFecha[0];

  const mes = partesFecha[1];

  const año = partesFecha[2];

  const partesHora =

    hora.split(':').map(Number);

  const inicio = new Date(

    año,

    mes - 1,

    dia,

    partesHora[0],

    partesHora[1]

  );

  // Duración provisional de 2 horas

  const fin = new Date(

    inicio.getTime() +

    2 * 60 * 60 * 1000

  );

  // ====================================================

  // 5. VISITANTE + INSTALACIÓN

  // ====================================================

  const posteriores =

    bloques

      .slice(indiceFecha + 1)

      .filter(b =>

        b &&

        b.trim().length > 0

      );

  const indiceVer =

    posteriores.findIndex(b =>

      b.trim().toLowerCase() === 'ver'

    );

  if (indiceVer === -1) {

    throw new Error(

      'No se encontró el enlace "Ver" del partido.'

    );

  }

  const instalacion =

    posteriores[indiceVer - 1];

  const equipoVisitante =

    posteriores[indiceVer - 2];

  if (

    !equipoVisitante ||

    !instalacion

  ) {

    throw new Error(

      'No se pudo identificar visitante e instalación.'

    );

  }

  // ====================================================

  // 6. GOOGLE MAPS

  // ====================================================

  const mapsUrl =

    'https\://www.google.com/maps/search/?api=1&query=' +

    encodeURIComponent(instalacion);

  // ====================================================

  // 7. DATOS DEL EVENTO

  // ====================================================

  // NORMA PARA TODOS LOS PARTIDOS:

  //

  // HORA + EQUIPOS + CATEGORÍA

  //

  // Ejemplo:

  //

  // 10:30 C.N. CATALUNYA vs A.E. SANTA EULÀLIA — JUVENIL FEMENINO

  const titulo =

    hora +

    ' ' +

    equipoLocal +

    ' vs ' +

    equipoVisitante +

    ' — ' +

    categoria;

  const descripcion =

    'CLUPIK_MATCH_ID:' +

    matchId +

    '\n\n' +

    '🏆 Competición: ' +

    competicion +

    '\n' +

    '🏷️ Categoría: ' +

    categoria +

    '\n' +

    '📅 Jornada/Fase: ' +

    jornada +

    '\n' +

    '📍 Instalación: ' +

    instalacion +

    '\n\n' +

    '🗺️ Google Maps:\n' +

    mapsUrl +

    '\n\n' +

    '🔗 Partido Clupik:\n' +

    matchUrl;

  // ====================================================

  // 8. BUSCAR EVENTO EXISTENTE

  // ====================================================

  // ====================================================
  // IMPORTANTE: buscar por CLUPIK_MATCH_ID en un rango amplio.
  // Esto permite reparar eventos creados con una fecha incorrecta.
  // ====================================================

  const margenBusquedaInicio =
    new Date(2020, 0, 1);

  const margenBusquedaFin =
    new Date(2035, 11, 31, 23, 59, 59);

  const eventos =
    calendario.getEvents(
      margenBusquedaInicio,
      margenBusquedaFin
    );

  const candidates = eventos.filter(evento => {
    const description = evento.getDescription() || '';
    const marker = new RegExp('(?:^|\\n)CLUPIK_MATCH_ID:' + matchId + '(?=\\s|$)');
    const identity = description.match(/\/tournament\/(\d+)\/match\/(\d+)\/results/i);
    return marker.test(description) && identity && identity[1] === source[1] && identity[2] === matchId;
  });
  if (candidates.length > 1) throw new Error('Identidad Clupik duplicada; se conservan todos los eventos: ' + source[1] + ':' + matchId);
  const eventoExistente = candidates[0] || null;

  // 9. CREAR O ACTUALIZAR

  // ====================================================

  if (eventoExistente) {

    eventoExistente.setTitle(

      titulo

    );

    eventoExistente.setTime(

      inicio,

      fin

    );

    eventoExistente.setLocation(

      instalacion

    );

    eventoExistente.setDescription(

      descripcion

    );

    // El calendario central NO utiliza invitados.

    // Eliminamos cualquier invitado que haya quedado

    // de versiones anteriores del script.

    eliminarInvitados_(eventoExistente);

    // El calendario central NO utiliza Google Meet.

    eliminarConferenciaGoogleMeet_(eventoExistente);

    Logger.log(

      'EVENTO ACTUALIZADO: ' +

      matchId

    );

  } else {

    // IMPORTANTE:

    // No se indican guests ni sendInvites.

    // El evento pertenece al calendario central.

    const nuevoEvento =

      calendario.createEvent(

        titulo,

        inicio,

        fin,

        {

          location: instalacion,

          description: descripcion

        }

      );

    // Si Google Calendar hubiese añadido

    // automáticamente una conferencia,

    // la eliminamos inmediatamente.

    eliminarConferenciaGoogleMeet_(nuevoEvento);

    Logger.log(

      'EVENTO CREADO: ' +

      matchId

    );

    Logger.log(

      'ID CALENDAR: ' +

      nuevoEvento.getId()

    );

  }

  // ====================================================

  // 10. REGISTRO

  // ====================================================

  Logger.log('--------------------------------');

  Logger.log(

    'ID CLUPIK: ' +

    matchId

  );

  Logger.log(

    equipoLocal +

    ' vs ' +

    equipoVisitante

  );

  Logger.log(

    'Categoría: ' +

    categoria

  );

  Logger.log(

    'Fecha: ' +

    fechaTexto

  );

  Logger.log(

    'Hora: ' +

    hora

  );

  Logger.log(

    'Jornada: ' +

    jornada

  );

  Logger.log(

    'Instalación: ' +

    instalacion

  );

}

// ======================================================

// OBTENER CATEGORÍA CORTA

// ======================================================

function obtenerCategoriaCorta_(competicion) {

  const texto =

    normalizarSinAcentos_(competicion);

  const categoriasBase = [

    'ALEVIN',

    'ALEVI',

    'INFANTIL',

    'CADET',

    'JUVENIL',

    'ABSOLUT'

  ];

  let categoriaBase = null;

  for (const categoria of categoriasBase) {

    if (

      new RegExp(

        '\\b' +

        categoria +

        '\\b'

      ).test(texto)

    ) {

      categoriaBase = categoria;

      break;

    }

  }

  if (!categoriaBase) {

    // Si no reconocemos la categoría,

    // no inventamos una.

    return competicion

      .replace(

        /\s+\d{2}\/\d{2}\s*$/i,

        ''

      )

      .trim();

  }

  let genero = '';

  if (

    /\bFEMENI\b/.test(texto)

  ) {

    genero = 'FEMENINO';

  } else if (

    /\bMASCULI\b/.test(texto)

  ) {

    genero = 'MASCULINO';

  } else if (

    /\bMIXT(?:O)?\b/.test(texto)

  ) {

    genero = 'MIXTO';

  }

  const baseMostrar = {

    'ALEVIN': 'ALEVÍN',

    'ALEVI': 'ALEVÍN',

    'INFANTIL': 'INFANTIL',

    'CADET': 'CADETE',

    'JUVENIL': 'JUVENIL',

    'ABSOLUT': 'ABSOLUTO'

  }[categoriaBase];

  let resultado =

    baseMostrar;

  if (genero) {

    resultado +=

      ' ' +

      genero;

  }

  // Detectar equipos A/B cuando formen

  // parte de la categoría.

  const marcadorGenero =

    genero === 'FEMENINO'

      ? 'FEMENI'

      : genero === 'MASCULINO'

        ? 'MASCULI'

        : genero === 'MIXTO'

          ? 'MIXT'

          : '';

  const indiceGenero =

    marcadorGenero

      ? texto.indexOf(marcadorGenero)

      : -1;

  if (indiceGenero !== -1) {

    const despuesGenero =

      texto.substring(

        indiceGenero +

        marcadorGenero.length

      ).trim();

    const grupo =

      despuesGenero.match(

        /^([AB])\b/

      );

    if (grupo) {

      resultado +=

        ' ' +

        grupo[1];

    }

  }

  return resultado;

}

// ======================================================

// NORMALIZAR TEXTO SIN ACENTOS

// ======================================================

function normalizarSinAcentos_(texto) {

  return texto

    .normalize('NFD')

    .replace(

      /[\u0300-\u036f]/g,

      ''

    )

    .toUpperCase()

    .trim();

}

// ======================================================

// ELIMINAR INVITADOS ANTIGUOS

// ======================================================

function eliminarInvitados_(evento) {

  const invitados =

    evento.getGuestList();

  for (const invitado of invitados) {

    try {

      const email =

        invitado.getEmail();

      evento.removeGuest(

        email

      );

      Logger.log(

        'Invitado eliminado: ' +

        email

      );

    } catch (error) {

      Logger.log(

        'No se pudo eliminar un invitado: ' +

        error.message

      );

    }

  }

}

// ======================================================

// ELIMINAR GOOGLE MEET / CONFERENCIA

// ======================================================

function eliminarConferenciaGoogleMeet_(
  evento
) {

  try {

    // CalendarApp.getId() devuelve el iCalUID del evento.
    // La Calendar API necesita el ID interno del recurso Event.
    const iCalUID = evento.getId();

    const token =
      ScriptApp.getOAuthToken();

    // 1. Buscar el evento mediante su iCalUID
    const urlBusqueda =
      'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(CALENDAR_ID) +
      '/events?iCalUID=' +
      encodeURIComponent(iCalUID) +
      '&maxResults=1&conferenceDataVersion=1';

    const respuestaBusqueda =
      UrlFetchApp.fetch(
        urlBusqueda,
        {
          method: 'get',
          headers: {
            Authorization:
              'Bearer ' +
              token
          },
          muteHttpExceptions: true
        }
      );

    const codigoBusqueda =
      respuestaBusqueda.getResponseCode();

    if (
      codigoBusqueda < 200 ||
      codigoBusqueda >= 300
    ) {

      Logger.log(
        'No se pudo localizar el evento en Calendar API. Código HTTP: ' +
        codigoBusqueda +
        ' - ' +
        respuestaBusqueda.getContentText()
      );

      return;
    }

    const datosEvento =
      JSON.parse(
        respuestaBusqueda.getContentText()
      );

    if (
      !datosEvento.items ||
      datosEvento.items.length === 0
    ) {

      Logger.log(
        'No se encontró en Calendar API el evento con iCalUID: ' +
        iCalUID
      );

      return;
    }

    const eventId =
      datosEvento.items[0].id;

    // 2. Eliminar la conferencia Google Meet
    const urlPatch =
      'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(CALENDAR_ID) +
      '/events/' +
      encodeURIComponent(eventId) +
      '?conferenceDataVersion=1&sendUpdates=none';

    const respuesta =
      UrlFetchApp.fetch(
        urlPatch,
        {
          method: 'patch',
          contentType: 'application/json',
          headers: {
            Authorization:
              'Bearer ' +
              token
          },
          payload: JSON.stringify({
            conferenceData: null
          }),
          muteHttpExceptions: true
        }
      );

    const codigo =
      respuesta.getResponseCode();

    if (
      codigo >= 200 &&
      codigo < 300
    ) {

      Logger.log(
        'Google Meet/conferencia eliminada del evento. ID interno: ' +
        eventId
      );

    } else {

      Logger.log(
        'No se pudo eliminar Google Meet. Código HTTP: ' +
        codigo +
        ' - ' +
        respuesta.getContentText()
      );
    }

  } catch (error) {

    Logger.log(
      'Error eliminando Google Meet: ' +
      error.message
    );
  }
}

// ======================================================

// INICIALIZAR EL SISTEMA

// ======================================================

function inicializarAESE() {

  PropertiesService

    .getScriptProperties()

    .setProperty(

      'ULTIMA_EJECUCION',

      new Date().toISOString()

    );

  Logger.log(

    'AESE inicializado correctamente.'

  );

}

// ======================================================

// PRUEBA: BUSCAR ÚLTIMAS 24 HORAS

// ======================================================

function pruebaUltimas24Horas() {

  const fecha =

    new Date(

      Date.now() -

      24 * 60 * 60 * 1000

    );

  PropertiesService

    .getScriptProperties()

    .setProperty(

      'ULTIMA_EJECUCION',

      fecha.toISOString()

    );

  Logger.log(

    'ULTIMA_EJECUCION establecida en: ' +

    fecha.toLocaleString()

  );

}
function pruebaActaWP_CrearPartido() {
  const CALENDAR_ID = '68af70845551fc729e20ff0ff1ca9f69bbbadde7031e6b90ace51fbcd279c7f@group.calendar.google.com';

  // Calendario ActaWP de Absoluto Masculino
  const url = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all';

  // Partido real de AESE que ya hemos identificado en ActaWP
  const MATCH_ID = '145573547';

  const respuesta = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (respuesta.getResponseCode() !== 200) {
    throw new Error(
      'ActaWP respondió con código ' + respuesta.getResponseCode()
    );
  }

  const html = respuesta.getContentText();

  // Localizamos la fila que contiene el partido.
  const posicion = html.indexOf('/match/' + MATCH_ID + '/results');

  if (posicion === -1) {
    throw new Error(
      'No se ha encontrado el partido ActaWP ' + MATCH_ID
    );
  }

  const inicio = html.lastIndexOf('<tr', posicion);
  const fin = html.indexOf('</tr>', posicion);

  if (inicio === -1 || fin === -1) {
    throw new Error('No se ha podido extraer la fila del partido.');
  }

  const fila = html.substring(inicio, fin + 5);

  // Equipos
  const equipos = [];
  const regexEquipo = /class="[^"]*colstyle-equipo[^"]*"[\s\S]*?<span[^>]*class="[^"]*ellipsis[^"]*"[^>]*>([\s\S]*?)<\/span>/g;

  let m;
  while ((m = regexEquipo.exec(fila)) !== null) {
    const equipo = limpiarHTML_(m[1]);
    if (equipo) equipos.push(equipo);
  }

  if (equipos.length < 2) {
    throw new Error(
      'No se han podido identificar los dos equipos.'
    );
  }

  // Fecha UTC de ActaWP: 2026-09-26 14:00 = 16:00 Barcelona
  const fechaMatch = fila.match(
    /data-sort="(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
  );

  if (!fechaMatch) {
    throw new Error('No se ha encontrado la fecha del partido.');
  }

  const fechaUTC = fechaMatch[1].replace(' ', 'T') + 'Z';
  const inicioEvento = new Date(fechaUTC);
  const finEvento = new Date(
    inicioEvento.getTime() + 60 * 60 * 1000
  );

  // Piscina
  let piscina = '';
  const piscinaMatch = fila.match(
    /class="[^"]*ellipsis[^"]*"[^>]*title="([^"]+)"/
  );

  if (piscinaMatch) {
    piscina = limpiarHTML_(piscinaMatch[1]);
  }

  const calendario = CalendarApp.getCalendarById(CALENDAR_ID);

  if (!calendario) {
    throw new Error(
      'No se ha podido acceder al calendario AESE Waterpolo-Partidos.'
    );
  }

  const titulo =
    '[PRUEBA ACTAWP] ' +
    equipos[0] +
    ' vs ' +
    equipos[1] +
    ' — ABSOLUTO MASCULINO';

  const descripcion =
    'PRUEBA DE SINCRONIZACIÓN ACTAWP\n\n' +
    'ActaWP Match ID: ' + MATCH_ID + '\n' +
    'Fuente: ' + url + '\n' +
    'Piscina: ' + piscina;

  const evento = calendario.createEvent(
    titulo,
    inicioEvento,
    finEvento,
    {
      description: descripcion,
      location: piscina
    }
  );

  Logger.log('======================================');
  Logger.log('PRUEBA ACTAWP CORRECTA');
  Logger.log('Evento creado: ' + evento.getId());
  Logger.log('Título: ' + titulo);
  Logger.log('Inicio: ' + inicioEvento);
  Logger.log('Piscina: ' + piscina);
  Logger.log('======================================');
}

function limpiarHTML_(texto) {
  return texto
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
