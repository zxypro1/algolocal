<div align="center">

<img src="./docs/icon.png" width="96" alt="AlgoLocal" />

# AlgoLocal

**Práctica de programación sin conexión: de problemas al estilo LeetCode a proyectos de ingeniería reales.**

<p>
  <a href="https://github.com/zxypro1/algolocal/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/zxypro1/algolocal?style=flat-square&color=14c8ff" /></a>
  <a href="https://github.com/zxypro1/algolocal/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/zxypro1/algolocal/total?style=flat-square&color=14c8ff" /></a>
  <a href="https://github.com/zxypro1/algolocal/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/zxypro1/algolocal?style=flat-square&color=ff7a32" /></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" />
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

[English](./README.md) &nbsp;·&nbsp; [中文](./README-zh.md) &nbsp;·&nbsp; [Sitio web](https://zxypro1.github.io/algolocal/) &nbsp;·&nbsp; [Discusiones](https://github.com/zxypro1/algolocal/discussions) &nbsp;·&nbsp; [Incidencias](https://github.com/zxypro1/algolocal/issues)

</div>

<br />

Resuelve problemas de algoritmos al estilo LeetCode en JavaScript, TypeScript o Python, y después construye proyectos de ingeniería por etapas evaluados por concurrencia, latencia, resiliencia y calidad del código. Todo se ejecuta en tu propia máquina; la asistencia de IA es opcional y usa el proveedor que configures.

<img alt="Resolviendo un problema de algoritmos, con las pruebas ejecutándose en el navegador" src="./docs/screenshots/practice-en.png" />

## Inicio rápido

### Aplicación de escritorio

No requiere dependencias. [Descargar la última versión](https://github.com/zxypro1/algolocal/releases/latest):

| Plataforma | Archivo |
|---|---|
| macOS (Apple Silicon) | `AlgoLocal-*-macOS-arm64.dmg` |
| macOS (Intel) | `AlgoLocal-*-macOS-x64.dmg` |
| Windows (Instalador) | `AlgoLocal-*-Windows-Setup.exe` |
| Windows (Portátil) | `AlgoLocal-*-Windows-Portable.exe` |
| Linux (AppImage) | `AlgoLocal-*-Linux.AppImage` |
| Linux (Debian, Ubuntu) | `AlgoLocal-*-Linux.deb` |
| Linux (Fedora, RHEL) | `AlgoLocal-*-Linux.rpm` |

#### Abrir la aplicación en macOS

Estas compilaciones llevan una firma ad-hoc, no un Apple Developer ID, así que macOS no puede
verificar al desarrollador y bloqueará el primer inicio. Para permitirlo:

1. Mueve **AlgoLocal** a Aplicaciones y haz doble clic. macOS dirá que no puede verificar que
   esté libre de malware — pulsa **Listo**.
2. Abre **Ajustes del Sistema → Privacidad y seguridad**, baja hasta Seguridad y pulsa
   **Abrir de todos modos** junto a AlgoLocal. Confirma con Touch ID o tu contraseña.

Solo hace falta una vez. En macOS Sequoia (15) y posteriores el atajo Control-clic → Abrir ya no
funciona, y `xattr -rd com.apple.quarantine` ni es necesario ni basta.

Eliminar el aviso por completo requiere un certificado Apple Developer ID de pago y notarización.
Compilar [desde el código fuente](#desde-el-código-fuente) lo evita.

### Desde el código fuente

Requiere Node.js 18 o superior y npm 8 o superior.

```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

La aplicación queda disponible en http://localhost:3000. `start-local.bat` (Windows) y `start-local.sh` (macOS, Linux) hacen lo mismo y ofrecen escribir un archivo de configuración de IA en la primera ejecución.

## Contenido

- [Inicio rápido](#inicio-rápido)
- [Características](#características)
- [Modos de práctica](#modos-de-práctica)
- [Lenguajes](#lenguajes)
- [Funciones de IA](#funciones-de-ia)
- [Uso](#uso)
- [Desarrollo](#desarrollo)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Documentación](#documentación)

## Características

| Capacidad | Detalle |
|---|---|
| Dos modos de práctica | Problemas de algoritmos y proyectos de ingeniería por etapas |
| Ejecución sin conexión | El código se ejecuta en el navegador mediante WebAssembly, sin ejecución en servidor |
| Datos locales | Problemas, borradores y estadísticas se guardan en el almacenamiento local |
| IA opcional | Generación de problemas, pistas, soluciones y revisión de ingeniería con tu propio proveedor |
| Editor | Monaco, con borradores guardados por problema y por lenguaje |
| Panel | Precisión por dificultad y etiqueta, mapa de calor de actividad, intentos recientes |
| Plataformas | Windows, macOS, Linux |

## Modos de práctica

### Problemas de algoritmos

Práctica de estilo entrevista: lee el enunciado, implementa la función, ejecuta los casos de prueba. Se incluyen 29 problemas y la biblioteca es ampliable.

### Práctica de ingeniería

Un proyecto es un sistema pequeño que se construye por etapas en un espacio de trabajo multi-archivo. Que funcione es necesario pero no suficiente: cada etapa mide además su comportamiento.

<img alt="Práctica de Ingeniería: espacio de trabajo multi-archivo con pruebas ocultas y umbrales de ingeniería" src="./docs/screenshots/engineering-en.png" />

| Componente | Descripción |
|---|---|
| Espacio de trabajo | Árbol de archivos, editor con pestañas, archivos de contrato de solo lectura, ficheros que se desbloquean por etapa |
| Pruebas de aceptación | Casos ocultos, ejecutados en un Web Worker |
| Umbrales de ingeniería | Aserciones sobre métricas medidas, por ejemplo concurrencia máxima de 4, o 12 peticiones en 300ms |
| Reloj virtual | `sleep(200)` no cuesta tiempo real y la latencia y la concurrencia siguen siendo medibles con exactitud |
| Puntuación | Corrección, concurrencia, latencia, resiliencia, encapsulación, elegancia |
| Revisión con IA | Lee el código, la última ejecución y las métricas estáticas, y lo revisa como un pull request de producción |

Se incluyen tres proyectos:

| Proyecto | Temas |
|---|---|
| Tubería de descarga resiliente | Concurrencia acotada, backoff, caché single-flight, cancelación |
| Tubería de pedidos dirigida por eventos | Bus de eventos, middleware tipo cebolla, idempotencia, cola de mensajes fallidos |
| Pasarela de API resiliente | Token bucket, circuit breaker, presupuestos de tiempo de espera |

Los proyectos también pueden generarse con IA. Un proyecto generado se ejecuta contra su propia solución de referencia antes de aceptarse. El formato de autoría está en la [Guía de Práctica de Ingeniería](./ENGINEERING-PRACTICE-GUIDE.md).

## Lenguajes

| Lenguaje | Ejecución |
|---|---|
| JavaScript | Nativa en el navegador |
| TypeScript | Transpilado por el compilador de TypeScript y luego ejecutado |
| Python | Pyodide (CPython compilado a WebAssembly) |

## Funciones de IA

Las cuatro funciones comparten una única configuración de proveedor.

| Función | Descripción |
|---|---|
| Generador de problemas | Crea un problema completo a partir de una descripción: enunciado, casos de prueba, plantillas y solución de referencia |
| Generador de soluciones | Propone varios enfoques con análisis de complejidad y sus compromisos |
| Asistente de chat | Responde sobre el código que hay en el editor sin revelar la solución completa |
| Revisión de ingeniería | Revisa una etapa terminada por seguridad ante concurrencia, comportamiento ante fallos, límites de módulo y estilo |

Proveedores soportados: DeepSeek, OpenAI, Claude, Qwen y modelos locales mediante Ollama. Consulta [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md).

## Uso

Problemas de algoritmos:

1. Elige un problema y un lenguaje.
2. Implementa la solución en el editor.
3. Pulsa "Enviar y Ejecutar Pruebas" para ejecutar los casos en el navegador.
4. Revisa los resultados, el tiempo de ejecución y las estadísticas del panel.

Proyectos de ingeniería:

1. Abre un proyecto y lee el enunciado de la etapa.
2. Implementa la etapa en el espacio de trabajo.
3. Pulsa "Ejecutar aceptación" para ejecutar las pruebas ocultas y evaluar los umbrales.
4. Revisa el resultado, las métricas, la puntuación y la revisión con IA si la pides. Al superar una etapa se desbloquea la siguiente.

Configuración y gestión de problemas:

- Los proveedores de IA se configuran en Ajustes (menú de la aplicación en escritorio, `/settings` en el navegador). La configuración de escritorio se guarda en `~/.offline-leet-practice/config.json`.
- Se pueden añadir problemas desde la página "Agregar Problema", importando JSON o editando `public/problems.json`. Consulta [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md).

## Desarrollo

| Comando | Propósito |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compilación de producción |
| `npm run test:engineering` | Pruebas del runtime de ingeniería y de los proyectos incluidos |
| `npm run test:ai` | Pruebas de proveedor, streaming y extracción de JSON |
| `npm run test:editor` | Pruebas de persistencia de borradores |
| `npm run projects:build` | Compila `projects/definitions` en `projects.json` |
| `npm run projects:verify` | Ejecuta cada etapa contra su solución de referencia |
| `npm run dist:mac` / `dist:win` / `dist:linux` / `dist:all` | Compilaciones de escritorio, ver [DESKTOP-APP-GUIDE.md](./DESKTOP-APP-GUIDE.md) |

Construido con React 18, Next.js 13, TypeScript, Mantine v7, Monaco Editor y Electron.

## Estructura del proyecto

```
algolocal/
├── pages/
│   ├── api/                    # Endpoints de problemas, IA y proyectos
│   ├── problems/[id].tsx       # Detalle del problema, con chat y soluciones de IA
│   ├── projects/               # Práctica de Ingeniería: lista, espacio de trabajo, generador
│   ├── generator.tsx           # Generador de problemas con IA
│   ├── stats.tsx               # Panel de práctica
│   ├── manage.tsx              # Gestión de problemas
│   └── index.tsx               # Lista de problemas
├── src/
│   ├── components/             # Componentes de React
│   ├── hooks/                  # Ejecutor WASM, ejecutor de etapas, configuración de IA
│   ├── lib/engineering/        # Reloj virtual, lab, runtime de módulos, runner de specs, puntuación
│   ├── lib/server/             # Proveedor de IA, almacén de proyectos, prompts
│   └── workers/                # Worker que ejecuta una etapa
├── projects/definitions/       # Fuentes de los proyectos de ingeniería
├── public/
│   ├── problems.json           # Base de datos de problemas
│   └── projects.json           # Base de datos de proyectos de ingeniería
├── electron-main.js
└── electron-builder.config.js
```

## Documentación

| Documento | Contenido |
|---|---|
| [ENGINEERING-PRACTICE-GUIDE.md](./ENGINEERING-PRACTICE-GUIDE.md) | Cómo funciona el runtime de ingeniería y cómo crear proyectos |
| [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md) | Configuración de proveedores, modelos, resolución de problemas |
| [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md) | Formato de los problemas y edición sin conexión |
| [DESKTOP-APP-GUIDE.md](./DESKTOP-APP-GUIDE.md) | Compilación y empaquetado de escritorio |

## Contribuir

Las contribuciones son bienvenidas. Los añadidos más útiles son nuevos problemas de algoritmos y proyectos de ingeniería; las mejoras al análisis, la interfaz y la documentación también se agradecen.

## Licencia

MIT
