# Brisa Notebook

Brisa Notebook es una aplicación de notas de código abierto que funciona sin conexión a internet.
Fue creada por una cooperativa de desarrolladores y se distribuye con la licencia Apache 2.0.

## Sincronización

Las notas se guardan primero en el dispositivo y se sincronizan cuando vuelve la conexión.
Si dos dispositivos editan la misma nota, Brisa conserva ambas versiones y pide al usuario que elija una.
La sincronización usa cifrado de extremo a extremo, así que el servidor nunca puede leer el contenido.

## Formatos

Brisa Notebook puede importar archivos Markdown, texto plano y listas de tareas en formato JSON.
Para exportar, ofrece Markdown y PDF; el formato PDF incluye un índice generado automáticamente.

## Búsqueda

La búsqueda funciona sobre un índice local y devuelve resultados en menos de cien milisegundos.
El índice se reconstruye en segundo plano cada vez que se importa una carpeta grande de notas.
