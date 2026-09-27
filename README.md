# TKounter Node Provision

Servicio local (LAN) que descubre y provisiona nodos TKounter (routers GL.iNet
con firmware OpenWrt), pilotado remotamente por el cliente web de
TKounterManager. Ver `src/provisioning.js` (lógica de descubrimiento/SSH) y
`src/server.js` (API HTTP local, `127.0.0.1:4783` por defecto).

## Requisitos de red para cada instalación (firewall del cliente)

Cada nodo necesita salida a internet para funcionar correctamente. Si la red
donde se instala tiene un firewall que restringe el tráfico saliente, hay que
pedir que se autoricen estos destinos (por **nombre de dominio**, no por IP
fija — las IPs de estos servicios pueden cambiar con el tiempo):

| Destino                                                   | Puerto                    | Para qué                                                                                                                        |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `*.techkovery.eu` (`nodes.` / `nodes-dev.` según entorno) | 443 (HTTPS)               | Envío de datos/estado del nodo (`HttpSender`/`StatusReporter` en TKounterNode)                                                  |
| `*.techkovery.eu`                                         | 80 (HTTP, solo `/ws`)     | Canal de comandos WebSocket                                                                                                     |
| IP/host del servidor + `tunnelPort` asignado al nodo      | 22 (o el puerto asignado) | Túnel SSH inverso (`autossh`) usado para acceso remoto admin                                                                    |
| `updates.techkovery.eu`                                   | 443 (HTTPS)               | Actualizaciones del binario `tkounter` (`Updater`)                                                                              |
| `fw.gl-inet.com`                                          | 443 (HTTPS)               | Feed de paquetes `opkg` del fabricante (GL.iNet) — necesario para instalar/actualizar `autossh`, `ca-bundle`, `libstdcpp`, etc. |

Si el firewall del cliente solo permite reglas por IP, hay que resolver estos
dominios en el momento de la instalación y anotar la IP resultante, sabiendo
que puede quedar obsoleta más adelante.

## Mantenimiento del almacén de CAs (`ca-bundle`) en los nodos

### El problema (incidente 2026-09)

Los nodos llevan un almacén de CAs (`ca-bundle`/`/etc/ssl/certs/ca-certificates.crt`)
que se instala una única vez durante el provisioning y **nunca se actualiza
solo**. El certificado del servidor (`techkovery.eu`) se renueva cada ~6 meses,
lo cual es normal y no rompe nada _mientras la CA emisora no cambie_. Pero si
en una renovación la CA (Sectigo) empieza a firmar con una intermedia/root
nueva (como pasó en 2026-09 con `Sectigo Public Server Authentication Root R46`,
introducido después de que se generase la imagen de firmware de los nodos),
cualquier nodo con el almacén de CAs desactualizado deja de poder validar la
conexión HTTPS aunque el certificado del servidor esté perfectamente bien
construido. Los síntomas típicos:

- `StatusReporter`/`HttpSender` (TKounterNode) loguean `curl error: Error`
  (el firmware OpenWrt compila `libcurl` sin _verbose strings_, así que el log
  del nodo no dice el motivo real; hay que reproducir con `curl -v` por SSH).
- El canal de comandos WebSocket (puerto 80, sin TLS) sigue funcionando con
  normalidad — solo falla el envío de datos por HTTPS (443).
- Diagnóstico: `openssl s_client -connect <host>:443 -servername <host> -showcerts`
  - `Verify return code: 20 (unable to get local issuer certificate)`.

### La solución permanente

1. **Nodos nuevos** (`prepareNode`/`finishProvisioning` en `src/provisioning.js`):
   `prepare-node.sh` instala `ca-bundle` si falta, y `finishProvisioning`
   instala además `src/node-scripts/update-ca-bundle.sh` en
   `/usr/bin/update-ca-bundle.sh` junto con una entrada de cron mensual
   (`/etc/crontabs/root`, `0 3 1 * * /usr/bin/update-ca-bundle.sh`) que corre
   `opkg update && opkg upgrade ca-bundle` de forma recurrente, sin
   intervención del manager ni del operador.
2. **Nodos ya desplegados** (no pasan por `finishProvisioning` de nuevo salvo
   re-provisioning): hay que aplicar el mismo mecanismo a mano por SSH, o
   esperar a un re-provisioning. El log de esta tarea queda en
   `/var/log/tkounter-ca-bundle-update.log` en el propio nodo.

Esto depende de que `fw.gl-inet.com` esté accesible desde el nodo (ver tabla
de arriba) — si el feed de `opkg` no es alcanzable, la tarea de cron falla en
silencio (revisar el log si un nodo antiguo vuelve a fallar por SSL en el
futuro).
