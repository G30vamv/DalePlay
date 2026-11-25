DalePlay · prototipo local

1. Ejecuta cargo run desde esta carpeta.
2. En Chrome o Edge 116+, abre chrome://extensions o edge://extensions.
   Activa el modo de desarrollador y carga la carpeta extension como
   extensión descomprimida. Repite en otro perfil del navegador.
3. Abre http://127.0.0.1:3190/ en cada perfil y espera a que cargue la pista.
4. Abre DalePlay en el primer perfil, crea la sala y copia su código.
   Usa el código para unirte desde la extensión del segundo perfil.
5. Desde el reproductor del anfitrión, reproduce, pausa o salta a otro
   punto. Compara los segundos en ambas ventanas. Si Chrome bloquea la
   reproducción inicial, pulsa reproducir una vez en la pestaña invitada.

El servidor se ejecuta en Rust. La interfaz actual vive en la extensión,
que controla elementos de audio y video HTML5 en la pestaña autorizada.
La app de escritorio Tauri y los adaptadores por servicio quedan pendientes.
El prototipo usa un servidor local y está preparado para probar dos perfiles
del mismo equipo. Usar salas por Internet requiere configurar un servidor
accesible, TLS y permitir esa dirección en la extensión.

La demo genera una pista de 90 segundos localmente. La extensión y el
servidor intercambian órdenes y tiempo de reproducción, sin enviar la pista.
