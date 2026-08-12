# AlgoLocal

[English](./README.md) | [中文](./README-zh.md)

Enlaces rápidos: [Discusiones](https://github.com/zxypro1/algolocal/discussions) | [Incidencias](https://github.com/zxypro1/algolocal/issues) | [Pull Requests](https://github.com/zxypro1/algolocal/pulls)

> Practica algoritmos de codificación 100% sin conexión con IA: genera problemas, obtén pistas, discute soluciones y ejecuta código en JavaScript, TypeScript o Python — sin necesidad de internet ni configuración.

<img width="1909" height="930" alt="2026" src="https://github.com/user-attachments/assets/7292075e-6d1b-4fc3-9019-7a80f17c1711" />

<img width="1909" height="930" alt="2025-08-24165302" src="https://github.com/user-attachments/assets/93116550-60af-41aa-b0f3-cc2b10fd5ac5" />

## Inicio Rápido

### Aplicación de Escritorio (Recomendada)

La aplicación de escritorio ofrece la mejor experiencia sin necesidad de configuración del entorno. Simplemente descarga y ejecuta.

**[Descargar Última Versión](https://github.com/zxypro1/algolocal/releases/latest)**

| Plataforma | Descarga |
|----------|----------|
| **macOS** (Apple Silicon) | `AlgoLocal-*-macOS-arm64.dmg` |
| **macOS** (Intel) | `AlgoLocal-*-macOS-x64.dmg` |
| **Windows** (Instalador) | `AlgoLocal-*-Windows-Setup.exe` |
| **Windows** (Portátil) | `AlgoLocal-*-Windows-Portable.exe` |
| **Linux** (AppImage) | `AlgoLocal-*-Linux.AppImage` |
| **Linux** (Debian/Ubuntu) | `AlgoLocal-*-Linux.deb` |
| **Linux** (Fedora/RHEL) | `AlgoLocal-*-Linux.rpm` |

**Usuarios de macOS**: Si encuentras "La aplicación está dañada y no se puede abrir", ejecuta en Terminal:
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### Versión Web (Alternativa)

Para desarrolladores que prefieren ejecutar desde el código fuente, consulta [Configuración de Desarrollo](#configuración-de-desarrollo) abajo.

## Características

### Funcionalidad Principal

- **Práctica con IA**: Genera problemas, obtén pistas, chatea sobre soluciones y genera explicaciones detalladas con múltiples enfoques — todo impulsado por IA
- **Soporte Completo Sin Conexión**: Funciona 100% sin conexión después de la configuración inicial, no se requiere internet durante la práctica
- **Ejecución de Código en WASM**: Ejecución del lado del navegador para JavaScript, TypeScript y Python
- **Editor de Código Monaco**: Experiencia de edición similar a VS Code con resaltado de sintaxis y autocompletado
- **Panel de Práctica**: Sigue tu progreso con estadísticas diarias, métricas de precisión, visualización de mapa de calor y tendencias de rendimiento
- **Biblioteca de Problemas Integrada**: 10+ problemas clásicos de algoritmos incluidos, fácilmente expandibles
- **Multiplataforma**: Se admite Windows, macOS y Linux

### Lenguajes Soportados

| Lenguaje | Estado | Implementación |
|----------|--------|----------------|
| **JavaScript** | Soportado | Ejecución nativa del navegador |
| **TypeScript** | Soportado | Transpilación del compilador de TypeScript |
| **Python** | Soportado | Pyodide (CPython WASM) |

Toda la ejecución de código ocurre en el navegador utilizando WebAssembly. No se requiere ejecución del lado del servidor.

### Funciones con IA

La aplicación incluye tres herramientas impulsadas por IA que comparten la misma configuración del proveedor:

- **Generador de Problemas con IA**: Describe lo que quieres practicar en lenguaje natural y la IA crea un problema completo con casos de prueba y soluciones de referencia
- **Generación de Soluciones con IA**: Genera múltiples enfoques de solución (fuerza bruta + optimizada) con anotaciones detalladas, análisis de complejidad y explicación de ventajas y desventajas
- **Asistente de Chat con IA**: Obtén pistas contextuales mientras resuelves problemas sin revelar la solución. Haz preguntas sobre tu código o enfoque actual
- **Configuración Flexible**: Cambia entre DeepSeek, OpenAI, Claude, Qwen u modelos locales de Ollama en cualquier momento

## Cómo Usar

### Resolución de Problemas

1. **Explorar Problemas**: Vista la lista de problemas con dificultad y etiquetas
2. **Seleccionar un Problema**: Haz clic en cualquier problema para abrir la página de detalles
3. **Elegir Lenguaje**: Selecciona JavaScript, TypeScript o Python
4. **Escribir Solución**: Usa el editor Monaco con todas las funciones de IDE
5. **Obtener Ayuda con IA** (Opcional):
   - **Chat con IA**: Pregunta por pistas o discute tu enfoque sin obtener la solución completa
   - **Solución con IA**: Genera soluciones completas anotadas con múltiples enfoques
6. **Ejecutar Pruebas**: Haz clic en "Enviar y Ejecutar Pruebas" para ejecutar tu código
7. **Ver Resultados**: Muestra resultados detallados de pruebas con tiempo de ejecución
8. **Seguir Progreso**: Consulta el Panel de Práctica para ver tus estadísticas y tendencias de rendimiento

### Generación de Problemas con IA

1. **Acceder al Generador**: Haz clic en "Generador de IA" en la página de inicio
2. **Describir Requisitos**: Introduce qué tipo de problema quieres (por ejemplo, "árbol de búsqueda binaria", "programación dinámica")
3. **Generar**: La IA crea un problema completo con casos de prueba y soluciones
4. **Practicar**: El problema generado está automáticamente disponible en tu biblioteca

### Análisis de Práctica

1. **Acceder al Panel**: Haz clic en "Estadísticas de Práctica" o "Panel" en la página de inicio
2. **Ver Estadísticas**: Muestra el total de problemas intentados, resueltos y tasa de precisión
3. **Analizar Rendimiento**: Revisa el desglose de precisión por nivel de dificultad y etiquetas de problemas
4. **Seguir Rachas**: Visualiza tu actividad diaria de práctica con un mapa de calor interactivo
5. **Revisar Historial**: Consulta tus intentos recientes e identifica áreas para mejorar

### Configuración de Parámetros

Accede a la página de configuración para configurar proveedores de IA:

- **Modo Escritorio**: A través del botón "Configuración" o menú de la aplicación
- **Modo Web**: Navega a `/settings` (por ejemplo, http://localhost:3000/settings)

Proveedores de IA soportados:
- DeepSeek
- OpenAI
- Qwen (Alibaba Cloud)
- Claude (Anthropic)
- Ollama (Local)

La configuración se guarda en `~/.offline-leet-practice/config.json` en modo escritorio. Consulta [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md) para la configuración detallada.

### Agregar Problemas Personalizados

1. **A través de la Interfaz**: Usa la página "Agregar Problema" en la aplicación
2. **Importación JSON**: Carga o pega datos de problemas en formato JSON
3. **Edición Directa**: Modifica `public/problems.json` para cambios inmediatos

Consulta [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md) para la guía completa.

## Configuración de Desarrollo

Para desarrolladores que desean ejecutar desde el código fuente o contribuir al proyecto.

### Prerrequisitos

- Node.js 18+ ([Descargar](https://nodejs.org/))
- npm 8+

### Ejecución Local

**Windows:**
```bash
start-local.bat
```

**macOS / Linux:**
```bash
chmod +x start-local.sh
./start-local.sh
```

**Configuración Manual:**
```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

Luego abre http://localhost:3000 en tu navegador.

### Construcción de la Aplicación de Escritorio

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

## Pila Tecnológica

- **Frontend**: React 18, Next.js 13, TypeScript
- **Framework de Interfaz de Usuario**: Mantine v7
- **Editor de Código**: Monaco Editor
- **Ejecución de Código**: WebAssembly
  - JavaScript: Constructor nativo de `Function` del navegador
  - TypeScript: Compilador de TypeScript (CDN)
  - Python: Pyodide (CPython compilado a WASM)
- **Escritorio**: Electron

## Estructura del Proyecto

```
OfflineLeetPractice/
├── pages/                  # Páginas y rutas API de Next.js
│   ├── api/
│   │   ├── problems.ts     # API de datos de problemas
│   │   ├── generate-problem.ts  # Generación de problemas con IA
│   │   ├── ai-solution.ts  # Generación de soluciones con IA
│   │   ├── ai-chat.ts      # Asistente de chat con IA
│   │   ├── add-problem.ts
│   │   └── ...
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
│   │   └── useWasmExecutor.ts
│   └── lib/
│       └── practiceStats.ts  # Seguimiento local de estadísticas
├── public/
│   └── problems.json       # Base de datos de problemas
├── electron-main.js        # Proceso principal de Electron
└── electron-builder.config.js
```

## Contribuir

Las contribuciones son bienvenidas. Áreas para mejorar:

- Más problemas de algoritmos
- Funciones de análisis de rendimiento
- Mejoras en la experiencia de usuario
- Mejoras en la documentación

## Licencia

Licencia MIT

---

**Practica algoritmos en cualquier lugar — en aviones, cruceros o cualquier entorno sin conexión.**
