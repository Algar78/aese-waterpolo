# Guía de pruebas · Fase 1 (roles, permisos y arreglos)

Duración aproximada: 20–30 minutos. Marca cada casilla al completarla y anota cualquier resultado distinto al esperado.

## 0. Preparación (una sola vez)

- [ ] **Ejecutar el SQL en este orden** en Supabase > SQL Editor:
  1. `20261004_phase1_roles_rls.sql` (si todavía no se ha ejecutado)
  2. No hace falta un segundo SQL para `created_by`: la migración actual ya establece `auth.uid()` como valor por defecto.
- [ ] **Ajustes del panel** (Authentication):
  - Desactivar el alta pública de usuarios («Allow new users to sign up» o «Enable sign ups»).
  - En URL Configuration, poner como Site URL `https://algar78.github.io/aese-waterpolo/` y añadir esa misma dirección con `?reset=1` en Redirect URLs.
- [ ] **Crear una cuenta de prueba de delegado**: Authentication > Users > Add user, con confirmación automática. Si usas Gmail, vale un alias como `tucorreo+delegado@gmail.com`, que llega a tu buzón.
- [ ] Ejecutar las comprobaciones 2b, 2c y 2d del SQL de Fase 1 (de una en una):
  - RLS activo en las tablas de la app.
  - Políticas esperadas presentes.
  - Un único `admin` (tú) y la cuenta de prueba con `role = user`.
- [ ] Abrir la web en el móvil y recargar una vez para que entre la versión nueva del service worker.

## 1. Como administrador (tu cuenta)

- [ ] Iniciar sesión: la cabecera muestra **👑 ADMIN**.
- [ ] **Crear un partido de prueba** (rival «PRUEBA 1»). Debe guardarse sin error.
  *Si falla con un mensaje de seguridad (RLS), revisar que la migración de Fase 1 esté ejecutada.*
- [ ] Iniciar el reloj y comprobar que la pantalla **no se apaga** tras 1–2 minutos sin tocarla.
- [ ] Registrar 2 goles de AESE, 1 gol del rival y **una expulsión al jugador con gorro 7** (no al primero de la lista).
- [ ] Finalizar el partido. En la pantalla final y en el historial, la expulsión aparece con el gorro 7 y su nombre.
- [ ] En el historial aparecen los botones **🗑 ELIMINAR**. Eliminar el partido «PRUEBA 1»: se borra.
- [ ] Durante el partido, comprobar el indicador superior: pasa por **↻ Guardando…** y vuelve a **● Guardado** cuando Supabase confirma la actualización.
- [ ] Simular un fallo de red durante una acción de guardado. El indicador debe quedar en **⚠ No sincronizado**, no en «Guardado».

## 2. Como delegado (cuenta de prueba, en una ventana privada o en otro móvil)

- [ ] Iniciar sesión: la cabecera muestra **👤 USUARIO**.
- [ ] Crear un partido «PRUEBA 2», registrar un gol y finalizar. Todo funciona.
- [ ] En el historial **no aparece ningún botón de eliminar**.
- [ ] **Intento de saltarse la interfaz.** Abrir las herramientas del navegador (consola) y ejecutar, sustituyendo el identificador por el de «PRUEBA 2»:

```js
await AESE_AUTH.client.from('matches').delete().eq('id', 'ID-DEL-PARTIDO').select()
```

Resultado esperado: `data` vacío (`[]`) o rechazo RLS. Recargar el historial: el partido sigue ahí.

- [ ] **Intento de modificar datos maestros:**

```js
await AESE_AUTH.client.from('players').insert({ full_name: 'ZZ_PRUEBA_BORRAR' })
```

Resultado esperado: un error con código `42501` (política de seguridad).

- [ ] **Partido de otra persona.** Pedir a otro usuario (o usar el admin) que cree un partido «PRUEBA 3». Con la cuenta de delegado, intentar modificarlo:

```js
await AESE_AUTH.client.from('matches').update({ rival: 'ZZ' }).eq('id', 'ID-DE-PRUEBA-3').select()
```

Resultado esperado: `data` vacío (`[]`) o rechazo RLS, sin cambios en el partido.

- [ ] Una vez finalizado un partido propio, intentar modificarlo desde consola. Debe quedar bloqueado por RLS.

## 3. Pruebas mínimas de lógica antes de la Fase 2

Estas pruebas se hacen antes de tocar el modo sin conexión porque afectan a la parte más delicada del partido.

- [ ] **Reloj:** iniciar → pausar → esperar 10 s → continuar. El tiempo no debe descontar los 10 s mientras está pausado.
- [ ] **Período:** finalizar P1. Los mismos 7 que terminaron P1 deben aparecer automáticamente en el agua para P2; después debe poder modificarse la alineación.
- [ ] **Sustitución:** durante el partido, sacar un jugador de una posición concreta e introducir otro desde el banquillo. El entrante debe ocupar exactamente la posición del saliente y debe quedar registrado el cambio.
- [ ] **Portero:** cada período debe exigir exactamente un portero en el agua.
- [ ] **Expulsión:** expulsar al jugador con gorro 7 y comprobar que el evento y el historial identifican al jugador correcto, no por su posición en la lista.
- [ ] **Final de partido:** un delegado puede finalizar su propio partido; después de quedar `completed`, ya no puede modificarlo.

## 4. Sin sesión

- [ ] En una ventana privada, sin iniciar sesión, abrir la consola en la web y ejecutar:

```js
await fetch(AESE_SUPABASE_CONFIG.url + '/rest/v1/players?select=*', {
  headers: { apikey: AESE_SUPABASE_CONFIG.publishableKey }
}).then(r => r.status + ' ' + r.statusText)
```

Resultado esperado: un error (401 o 403) o una lista vacía. **Nunca** una lista de jugadores.

## 5. Recuperación de contraseña

- [ ] En la pantalla de acceso, pedir «¿Has olvidado tu contraseña?» con la cuenta de prueba.
- [ ] El enlace del correo abre `algar78.github.io/aese-waterpolo/?reset=1` (no `localhost`) y permite fijar una contraseña nueva.

## 6. Limpieza

- [ ] Borrar los partidos de prueba que queden (desde la cuenta de administrador).
- [ ] Decidir qué hacer con la cuenta de prueba: eliminarla o dejarla para futuras pruebas, sin usar datos de jugadores reales en las capturas que compartas.

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| «Cuenta pendiente de configuración» al entrar | No se ha ejecutado el SQL de la Fase 1 o el usuario no tiene fila en `profiles` |
| Error de seguridad al crear un partido | Falta ejecutar la migración actual de Fase 1 |
| El delegado ve botones de eliminar | La versión de la web es antigua: recargar dos veces |
| El indicador queda en «⚠ No sincronizado» | Error de red, RLS o intento de modificar un partido ya finalizado |
| El correo de recuperación lleva a una página que no existe | Falta añadir la URL en Redirect URLs |
| La consola da «AESE_AUTH is not defined» | Se ha abierto la consola en otra pestaña o dominio |
