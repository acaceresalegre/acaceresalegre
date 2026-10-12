# Conectar Cuentas Casa con la planilla de Google

Se hace una sola vez, desde una computadora, con la cuenta de Google dueña de la planilla
«Cuentas Casa - base de datos». Lleva unos 10 minutos.

## 1. Pegar el programa en la planilla

1. Abrí la planilla y andá a **Extensiones → Apps Script**. Se abre el editor en otra pestaña.
2. Borrá todo lo que hay en el archivo `Código.gs` y pegá el contenido de
   [`Codigo.gs`](https://raw.githubusercontent.com/acaceresalegre/acaceresalegre/main/hogar/apps-script/Codigo.gs)
   (abrí el enlace, seleccioná todo y copiá).
3. Guardá con el ícono del disquete (o Ctrl+S).

## 2. Publicarlo como aplicación web

1. En el editor: **Implementar → Nueva implementación**.
2. En el engranaje de «Seleccionar tipo», elegí **Aplicación web**.
3. Completá:
   - Descripción: `Cuentas Casa`
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
4. **Implementar**. Google pide permisos:
   - Elegí tu cuenta.
   - Si aparece «Google no verificó esta aplicación», tocá **Configuración avanzada → Ir a Cuentas Casa (no seguro)**.
     Es el aviso normal para programas propios; el programa es el que pegaste y solo trabaja sobre tu planilla y tu calendario.
   - **Permitir**.
5. Copiá la **URL de la aplicación web** (termina en `/exec`). La vas a necesitar en el paso 4 si la planilla te la pide.

«Cualquier usuario» significa que la app puede llamar al programa sin iniciar sesión en Google.
Igual nadie puede leer ni escribir sin el código de acceso secreto que se crea en el paso 3.

## 3. Instalar

1. Volvé a la planilla y recargá la página. Aparece el menú **Cuentas Casa** (puede tardar unos segundos).
2. **Cuentas Casa → 1. Instalar**. La primera vez pide permisos de nuevo (los mismos pasos que arriba).
3. Al terminar avisa «Listo». En ese momento:
   - se crea el calendario **Cuentas Casa** en tu Google Calendar con los vencimientos de este mes y el próximo, a las 9:00 y con avisos;
   - se programa una actualización automática cada hora (facturas nuevas de cada mes y cambios en el calendario);
   - se corrige la tasa ARS de la pestaña Ajustes (había quedado en 2,14).

## 4. Conectar los celulares

1. **Cuentas Casa → 2. Conectar la app**. Aparecen dos enlaces: uno para Alan y otro para Karo.
2. Mandale a cada uno su enlace (por WhatsApp o mail) y abrilo **en el celular**, en el mismo navegador donde usan la app.
3. La app pregunta si reemplaza los datos del celular por los de la planilla: **Aceptar**.

Listo: lo que carga uno aparece en el otro en unos 20 segundos, y en la planilla al instante.

Los enlaces incluyen el código de acceso: no los compartas con nadie más.

## 5. Compartir con Karo

- **Planilla**: botón **Compartir** → mail de Karo → Editor.
- **Calendario**: en Google Calendar, junto a «Cuentas Casa» → **Configuración y uso compartido → Compartir con
  determinadas personas** → mail de Karo → «Hacer cambios en los eventos».

## Si algo falla

- **La app dice «Código de acceso inválido»**: usá de nuevo «2. Conectar la app» y abrí el enlace nuevo.
- **Cambiaste el programa** (por ejemplo, una versión nueva de `Codigo.gs`): pegalo, guardá y en
  **Implementar → Gestionar implementaciones → editar (lápiz) → Versión: Nueva versión → Implementar**.
  La URL no cambia.
- **No aparecen eventos en el calendario**: **Cuentas Casa → Crear facturas y actualizar calendario ahora**.
