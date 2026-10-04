# AESE Waterpolo · Fase 1 · Seguridad y usuarios

## 1. Ejecutar la migración

En Supabase > SQL Editor, ejecutar el archivo:

supabase/migrations/20261004_phase1_roles_rls.sql

La migración:
- crea public.profiles;
- asigna role=user a usuarios existentes;
- asigna role=admin a algarri1978@gmail.com;
- crea el rol admin/user;
- añade matches.created_by con auth.uid() por defecto;
- protege plantillas y datos maestros con RLS;
- permite a usuarios autenticados trabajar con partidos propios;
- reserva el borrado de partidos y convocados al administrador.

## 2. Authentication

En Supabase > Authentication > General:
- desactivar "Allow new users to sign up";
- mantener habilitado Email/Password;
- mantener confirmación de email si se quiere exigir verificación.

Los nuevos delegados se crean mediante Authentication > Users > Add user > Send invitation. Nunca se debe poner una secret/service key dentro de la PWA.

## 3. URL de recuperación

En Authentication > URL Configuration:

Site URL:
https://algar78.github.io/aese-waterpolo/

Additional Redirect URLs:
https://algar78.github.io/aese-waterpolo/?reset=1

La aplicación ya no utiliza localhost para recuperar contraseña.

## 4. Prueba mínima de roles

Administrador:
- algarri1978@gmail.com entra;
- debe aparecer "ADMIN";
- puede eliminar un partido.

Usuario:
- debe aparecer "USUARIO";
- puede consultar plantillas e historial;
- puede crear/actualizar sus propios partidos;
- no debe ver botones de eliminar;
- aunque intente ejecutar el DELETE desde el navegador, RLS debe rechazarlo.

## 5. Nota de seguridad

Ocultar botones no es la seguridad. La protección real está en las políticas RLS de Supabase. La PWA solamente refleja el rol.
