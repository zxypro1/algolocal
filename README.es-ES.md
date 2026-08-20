# AlgoLocal

[English](./README.md) | [中文](./README-zh.md)

Enlaces rápidos: [Discusiones](https://github.com/zxypro1/algolocal/discussions) | [Incidencias](https://github.com/zxypro1/algolocal/issues) | [Pull Requests](https://github.com/zxypro1/algolocal/pulls)

> Práctica de programación que se ejecuta por completo en tu propia máquina. Resuelve problemas de algoritmos al estilo LeetCode en JavaScript, TypeScript o Python, y luego construye proyectos de ingeniería por etapas que se evalúan por concurrencia, latencia, resiliencia y calidad del código. IA opcional, con el proveedor que tú elijas, sin cuenta y sin conexión.

<img alt="Resolviendo un problema de algoritmos, con las pruebas ejecutándose en el navegador" src="./docs/screenshots/practice-en.png" />

<img alt="Práctica de Ingeniería: espacio de trabajo multi-archivo con pruebas ocultas y umbrales de ingeniería" src="./docs/screenshots/engineering-en.png" />

## Inicio rápido

### Aplicación de escritorio

No hay nada que instalar ni configurar. Descárgala y ejecútala.

[Descargar la última versión](https://github.com/zxypro1/algolocal/releases/latest)

| Plataforma | Descarga |
|----------|----------|
| macOS (Apple Silicon) | `AlgoLocal-*-macOS-arm64.dmg` |
| macOS (Intel) | `AlgoLocal-*-macOS-x64.dmg` |
| Windows (Instalador) | `AlgoLocal-*-Windows-Setup.exe` |
| Windows (Portátil) | `AlgoLocal-*-Windows-Portable.exe` |
| Linux (AppImage) | `AlgoLocal-*-Linux.AppImage` |
| Linux (Debian/Ubuntu) | `AlgoLocal-*-Linux.deb` |
| Linux (Fedora/RHEL) | `AlgoLocal-*-Linux.rpm` |

Si macOS dice que la aplicación está dañada y no se puede abrir, quita el atributo de cuarentena:
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### Desde el código fuente

Consulta [ejecutar en local](#ejecutar-en-local) más abajo.

## Características

Dos formas de practicar. Los problemas de algoritmos son los de siempre, los que repasas en LeetCode antes de una entrevista: lee el enunciado, escribe una función, ejecuta las pruebas. La Práctica de Ingeniería es la otra mitad, descrita más abajo: construyes un sistema pequeño de varios archivos por etapas y se te evalúa por concurrencia, latencia, resiliencia y por cómo se lee el código.

Todo se ejecuta en tu máquina. Después de la configuración inicial no hace falta internet, el código corre en el navegador mediante WebAssembly y tus intentos se quedan en el almacenamiento local, no en el servidor de nadie. La IA está cuando la quieres y callada cuando no.

El editor es Monaco, el mismo de VS Code, con resaltado de sintaxis, autocompletado y borradores guardados por problema y por lenguaje. El panel registra qué resolviste y cuándo, con precisión por dificultad y por etiqueta, un mapa de calor de actividad diaria y tus intentos recientes. Vienen 29 problemas incluidos y puedes añadir los tuyos.

Funciona en Windows, macOS y Linux.

### Lenguajes

| Lenguaje | Cómo se ejecuta |
|----------|-----------------|
| JavaScript | De forma nativa en el navegador |
| TypeScript | Transpilado por el compilador de TypeScript y luego ejecutado |
| Python | Pyodide, CPython compilado a WebAssembly |

No hay ejecución en el servidor.

### Qué hace la IA

Cuatro funciones comparten una sola configuración de proveedor, así que la clave se pone una vez.

El generador de problemas toma una descripción en lenguaje natural y escribe un problema completo: enunciado, casos de prueba con sus casos límite, plantillas iniciales y una solución de referencia. El generador de soluciones propone varios enfoques para un problema que se te atraganta, del más ingenuo al optimizado, cada uno anotado con su complejidad y su compromiso. El asistente de chat responde sobre el código que ya escribiste sin darte la solución, y la revisión de ingeniería comenta una etapa terminada como lo haría un revisor en un pull request de producción.

Puedes usar DeepSeek, OpenAI, Claude, Qwen o un modelo local de Ollama, y cambiar entre ellos cuando quieras. Consulta [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md).

## Práctica de ingeniería

Los problemas de algoritmos preguntan si tu función es correcta. La Práctica de Ingeniería hace las
preguntas que deciden si el código llega a producción: ¿sigue siendo correcto bajo concurrencia?,
¿respeta un presupuesto de latencia?, ¿qué pasa cuando la dependencia se cae?, ¿puede alguien más
mantenerlo?

Un proyecto es un pequeño sistema que construyes por etapas en un espacio de trabajo multi-archivo real:

- Un árbol de archivos, editor Monaco con pestañas, archivos de contrato de solo lectura y ficheros que se desbloquean según avanzas
- Cada etapa añade una preocupación de ingeniería y desbloquea la siguiente
- Pruebas de aceptación ocultas, más umbrales de ingeniería sobre métricas medidas ("concurrencia máxima ≤ 4", "12 peticiones en 300ms")
- Un reloj virtual: `sleep(200)` no cuesta tiempo real, pero la latencia y la concurrencia se siguen midiendo con exactitud
- Puntuación en corrección, concurrencia, latencia, resiliencia, encapsulación y elegancia
- Revisión con IA que lee tu código, la última ejecución y las métricas estáticas, y lo revisa como un pull request de producción
- Generación con IA: describe lo que quieres practicar y el proyecto generado se ejecuta contra su propia solución de referencia antes de aceptarse

Se incluyen tres proyectos: una tubería de descarga resiliente (concurrencia acotada, backoff,
single-flight, cancelación), una tubería de pedidos dirigida por eventos (bus de eventos, middleware
tipo cebolla, idempotencia, DLQ) y una pasarela de API resiliente (token bucket, circuit breaker,
presupuestos de tiempo de espera).

Consulta la [Guía de Práctica de Ingeniería](./ENGINEERING-PRACTICE-GUIDE.md) para crear los tuyos.

## Cómo se usa

Elige un problema de la lista, elige el lenguaje y escribe la solución en el editor. "Enviar y Ejecutar Pruebas" lo ejecuta en el navegador y muestra cada caso con su tiempo. Si te atascas, el chat da pistas sobre el código que tienes escrito, y el generador de soluciones desarrolla varios enfoques cuando decidas verlos. Lo que resuelves aparece en el panel.

En Práctica de Ingeniería abres un proyecto, lees el enunciado de la etapa a la izquierda, escribes en el espacio de trabajo y pulsas "Ejecutar aceptación". Obtienes el resultado de las pruebas, las métricas medidas, los umbrales de ingeniería, una puntuación en las seis dimensiones y una revisión con IA si la pides. Al superar una etapa se desbloquea la siguiente.

Para generar un problema, abre el Generador de IA y describe lo que quieres practicar, por ejemplo "árbol de búsqueda binaria" o "programación dinámica con subestructura óptima". El problema generado queda en tu biblioteca.

Los proveedores de IA se configuran en Ajustes: el botón "Configuración" o el menú de la aplicación en el escritorio, `/settings` en el navegador. En el escritorio la configuración se guarda en `~/.offline-leet-practice/config.json`.

Puedes añadir problemas desde la página "Agregar Problema", pegando o subiendo JSON, o editando `public/problems.json` directamente. El formato está en [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md).

## Ejecutar en local

Necesitas Node.js 18 o superior ([descargar](https://nodejs.org/)) y npm 8 o superior.

Windows:
```bash
start-local.bat
```

macOS y Linux:
```bash
chmod +x start-local.sh
./start-local.sh
```

O a mano:
```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

Luego abre http://localhost:3000 en tu navegador.

### Construir la aplicación de escritorio

```bash
# macOS
npm run dist:mac

# Windows
npm run dist:win

# Linux
npm run dist:linux

# Todas las plataformas
npm run dist:all
```

Consulta [DESKTOP-APP-GUIDE.md](./DESKTOP-APP-GUIDE.md) para instrucciones detalladas de compilación.

## Construido con

React 18 y Next.js 13 en TypeScript, Mantine v7 para la interfaz, Monaco como editor y Electron para las versiones de escritorio. La ejecución de código va sobre WebAssembly: JavaScript usa el constructor `Function` del navegador, TypeScript se transpila antes con el compilador de TypeScript, y Python corre sobre Pyodide.

## Estructura del proyecto

```
algolocal/
├── pages/                  # Páginas y rutas API de Next.js
│   ├── api/
│   │   ├── problems.ts     # API de datos de problemas
│   │   ├── generate-problem.ts  # Generación de problemas con IA
│   │   ├── ai-solution.ts  # Generación de soluciones con IA
│   │   ├── ai-chat.ts      # Asistente de chat con IA
│   │   ├── add-problem.ts
│   │   └── ...
│   ├── projects/           # Práctica de Ingeniería: lista, espacio de trabajo, generador
│   ├── problems/[id].tsx   # Página de detalles de problemas (con chat de IA + solución de IA)
│   ├── generator.tsx       # Página del Generador de IA
│   ├── stats.tsx           # Página del Panel de Práctica
│   ├── manage.tsx          # Página de gestión de problemas
│   └── index.tsx           # Página de inicio
├── src/
│   ├── components/         # Componentes React
│   │   ├── PracticeDashboard.tsx  # Visualización de estadísticas
│   │   ├── ContributionHeatmap.tsx
│   │   └── ...
│   ├── hooks/
│   │   ├── useWasmExecutor.ts
│   │   └── useProjectRunner.ts   # Ejecuta una etapa en un Web Worker
│   ├── lib/
│   │   ├── practiceStats.ts  # Seguimiento local de estadísticas
│   │   └── engineering/      # Reloj virtual, lab, runtime de módulos, specs, puntuación
│   └── workers/
│       └── projectRunner.worker.ts
├── projects/
│   ├── definitions/        # Fuentes de los proyectos de ingeniería
│   └── projects.json
├── public/
│   ├── problems.json       # Base de datos de problemas
│   └── projects.json       # Base de datos de proyectos de ingeniería
├── electron-main.js        # Proceso principal de Electron
└── electron-builder.config.js
```

## Contribuir

Las contribuciones son bienvenidas. Lo más útil que puedes añadir son más problemas de algoritmos y más proyectos de ingeniería; las mejoras al análisis, a la interfaz y a esta documentación también se agradecen.

## Licencia

Licencia MIT

---

Practica donde sea: en un avión, en un crucero, detrás del cortafuegos de la empresa o en cualquier sitio sin conexión.
