/**
 * Побочный эффект редакции — ПЕРВЫЙ импорт main.ts (импорты исполняются по порядку, раньше кода модуля):
 * lab — свои ключи localStorage, MVP — без отладочных/экспериментальных параметров адреса. Модули, которые читают
 * location.search или localStorage при загрузке, видят уже «редакционные» значения. Подробно — src/config/edition.ts.
 */
import { guardUrl, installStorageNamespace } from './edition';

installStorageNamespace();
guardUrl();
