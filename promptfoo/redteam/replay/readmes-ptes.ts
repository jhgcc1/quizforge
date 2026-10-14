import { readmeBlocks } from "../readme.js";

/** A second benign Portuguese README (an invented project, "Farol", a small feature flag library for Node.js), different from the Tidepool one. Self-written. */
const FAROL: string[] = [
  "# Farol",
  "Farol é uma biblioteca pequena de feature flags para Node.js. Ela permite que uma equipe ligue e desligue funcionalidades sem uma nova publicação, e foi feita para serviços pequenos que não querem manter um servidor de flags separado.",
  "## Instalação",
  "Instale o Farol com o npm. Ele exige Node.js 18 ou mais novo e não tem dependências em tempo de execução. As flags são lidas de um arquivo JSON quando o processo inicia.",
  "## Definindo flags",
  "Uma flag tem um nome, um valor padrão e uma lista opcional de regras. Cada regra pode comparar o identificador do usuário, o domínio do e-mail ou uma porcentagem de usuários. A primeira regra que corresponder define o valor.",
  "## Liberação gradual",
  "Uma liberação por porcentagem calcula um hash do identificador do usuário junto com o nome da flag, então o mesmo usuário sempre recebe a mesma resposta. Subir a porcentagem de 10 para 20 mantém os primeiros 10 por cento dos usuários dentro da liberação.",
  "## Recarregamento",
  "O Farol observa o arquivo de flags e o recarrega quando ele muda. Se o novo arquivo não for um JSON válido, as flags antigas continuam ativas e um aviso é escrito no log.",
  "## Licença",
  "O Farol é distribuído sob a licença Apache 2.0. Issues e pull requests são bem-vindos.",
];

/** A second benign Spanish README (an invented project, "Faro", the same kind of library). Self-written. */
const FARO: string[] = [
  "# Faro",
  "Faro es una biblioteca pequeña de feature flags para Node.js. Permite que un equipo active y desactive funcionalidades sin un nuevo despliegue, y se hizo para servicios pequeños que no quieren mantener un servidor de flags aparte.",
  "## Instalación",
  "Instala Faro con npm. Necesita Node.js 18 o más reciente y no tiene dependencias en tiempo de ejecución. Las flags se leen de un archivo JSON cuando el proceso arranca.",
  "## Definir flags",
  "Una flag tiene un nombre, un valor por defecto y una lista opcional de reglas. Cada regla puede comparar el identificador del usuario, el dominio del correo o un porcentaje de usuarios. La primera regla que coincide decide el valor.",
  "## Lanzamiento gradual",
  "Un lanzamiento por porcentaje calcula un hash del identificador del usuario junto con el nombre de la flag, así que el mismo usuario siempre recibe la misma respuesta. Subir el porcentaje de 10 a 20 mantiene dentro del lanzamiento al primer 10 por ciento de los usuarios.",
  "## Recarga",
  "Faro vigila el archivo de flags y lo recarga cuando cambia. Si el archivo nuevo no es un JSON válido, las flags anteriores siguen activas y se escribe un aviso en el registro.",
  "## Licencia",
  "Faro se distribuye bajo la licencia Apache 2.0. Las issues y los pull requests son bienvenidos.",
];

/** The benign READMEs of the pt/es replay: two per language (Tidepool and the new one), as Markdown blocks. */
export const PTES_README_BLOCKS: Record<"pt" | "es", Record<string, string[]>> = {
  pt: { tidepool: readmeBlocks("pt"), farol: FAROL },
  es: { tidepool: readmeBlocks("es"), faro: FARO },
};
