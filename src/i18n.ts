// ──────────────────────────────────────────
// Internationalisation (backend)
// ──────────────────────────────────────────
// Flat message catalogue keyed by dotted id. `en` is the source language: any
// message missing from a translation falls back to it, then to the key itself.
// The same catalogue is mirrored in the frontend (frontend/src/app/shared/i18n/*),
// so API error strings and UI strings share one vocabulary.

export type Lang = 'en' | 'fr' | 'es' | 'de';

export const DEFAULT_LANG: Lang = 'en';

// Supported languages, in menu order.
export const LANGS: Lang[] = ['en', 'fr', 'es', 'de'];

type Catalogue = Record<string, string>;

const en: Catalogue = {
  // ── Auth ───────────────────────────────────────────────────────────────────
  'auth.required': 'Authentication required',
  'auth.admin_required': 'Admin role required',
  'auth.invalid_credentials': 'Invalid username or password',
  'auth.password_login_disabled': 'Password login is disabled',
  'auth.login_failed': 'Login failed',
  'auth.username_required': 'username is required',
  'auth.user_exists': 'User already exists',
  'auth.unknown_user': 'Unknown user',
  'auth.role_required': 'username and role are required',
  'auth.own_role': 'Cannot change your own role',
  'auth.own_delete': 'Cannot delete your own account',
  'auth.oidc_not_configured': 'OIDC not configured',
  'auth.oidc_unreachable': 'OIDC provider unreachable',
  'auth.oidc_missing_code': 'Missing code or state parameter',
  'auth.oidc_invalid_state': 'Invalid or expired state parameter',
  'auth.oidc_token_failed': 'Token exchange failed',
  'auth.oidc_failed': 'OIDC authentication failed',
  'auth.email_required': 'email is required',
  'auth.invalid_email': 'Invalid email address',
  'auth.current_password_wrong': 'Current password is incorrect',
  'auth.password_too_short': 'Password must be at least 8 characters',
  'auth.password_changed': 'Password updated',
  'auth.rate_limited': 'Too many attempts, try again later',

  // ── Two-factor (TOTP) ──────────────────────────────────────────────────────
  'auth.totp_required': 'Two-factor code required',
  'auth.totp_invalid': 'Invalid two-factor code',
  'auth.totp_disabled_with_oidc': 'Two-factor authentication is managed by your identity provider',
  'auth.totp_already_enabled': 'Two-factor authentication is already enabled',
  'auth.totp_enabled': 'Two-factor authentication enabled',
  'auth.totp_disabled': 'Two-factor authentication disabled',
  'auth.totp_secret_invalidated': 'Two-factor setup cancelled, scan again to get a new secret',

  // ── Password recovery ──────────────────────────────────────────────────────
  'auth.reset_requested': 'If the account exists, a recovery link has been sent',
  'auth.reset_sent': 'Password recovery link sent',
  'auth.reset_invalid_token': 'This recovery link is invalid or has expired',
  'auth.reset_done': 'Password updated, you can sign in now',

  // ── Profile ────────────────────────────────────────────────────────────────
  'profile.updated': 'Profile updated',
  'profile.avatar_updated': 'Avatar updated',
  'profile.avatar_removed': 'Avatar reset to Gravatar',
  'profile.avatar_invalid': 'Unsupported image format',
  'profile.avatar_too_large': 'Image is too large',
  'profile.lang_updated': 'Language updated',
  'profile.theme_updated': 'Colour scheme updated',

  // ── Scenarios ──────────────────────────────────────────────────────────────
  'scenario.not_found': 'Scenario not found',
  'scenario.invalid_name': 'Invalid scenario name',
  'scenario.save_failed': 'Save failed',
  'scenario.import_failed': 'Import failed',
  'scenario.not_found_on_disk': 'Scenario not found on disk',
  'scenario.load_failed': 'Failed to load scenario config',
  'scenario.duplicate': 'already exists',

  // ── Users ──────────────────────────────────────────────────────────────────
  'users.load_failed': 'Failed to load users',
  'users.create_failed': 'Failed to create user',
  'users.role_failed': 'Failed to update role',
  'users.password_failed': 'Failed to update password',
  'users.delete_failed': 'Failed to delete user',
  'users.password_set': 'Password for {name}',
  'users.password_updated': 'Password updated for {name}',
  'users.delete_confirm': 'Delete user {name}?',

  // ── Errors ─────────────────────────────────────────────────────────────────
  'error.internal': 'Internal server error',
  'error.import_unconfigured': 'Server not configured for import',
  'error.export_unconfigured': 'Server not configured for export',
  'error.yaml_required': 'YAML content required',
  'error.yaml_field_required': 'YAML content required in "yaml" or "scenarios" field',
  'error.name_mismatch': 'Scenario name in YAML does not match URL',
  'error.run_unconfigured': 'Server not configured for manual runs',
  'error.not_running': 'Scenario not currently running',
  'error.not_scheduled': 'Scenario not found or not scheduled',
  'error.config_export_unconfigured': 'Server not configured for config export',
  'error.config_save_unconfigured': 'Server not configured for config save',
  'error.config_delete_unconfigured': 'Server not configured for config delete',

  // ── Public status page ─────────────────────────────────────────────────────
  'status.title': '{name} — Scenarii Status',
  'status.auto_refresh': 'Status page — auto-refreshes every 30s',
  'status.current': 'Current Status',
  'status.sla': 'SLA ({days}d)',
  'status.total_runs': 'Total Runs',
  'status.passed': 'Passed',
  'status.failed': 'Failed',
  'status.duration_trend': 'Response Time Trend',
  'status.success_trend': 'Success Rate Over Time',
  'status.no_runs': 'No runs yet',
  'status.pass': 'Pass',
  'status.fail': 'Fail',
  'status.footer': 'Scenarii',
};

const fr: Catalogue = {
  'auth.required': 'Authentification requise',
  'auth.admin_required': 'Rôle administrateur requis',
  'auth.invalid_credentials': 'Identifiant ou mot de passe incorrect',
  'auth.password_login_disabled': 'La connexion par mot de passe est désactivée',
  'auth.login_failed': 'Échec de la connexion',
  'auth.username_required': "l'identifiant est requis",
  'auth.user_exists': 'Cet utilisateur existe déjà',
  'auth.unknown_user': 'Utilisateur inconnu',
  'auth.role_required': "l'identifiant et le rôle sont requis",
  'auth.own_role': 'Impossible de modifier son propre rôle',
  'auth.own_delete': 'Impossible de supprimer son propre compte',
  'auth.oidc_not_configured': 'OIDC non configuré',
  'auth.oidc_unreachable': 'Fournisseur OIDC injoignable',
  'auth.oidc_missing_code': 'Paramètre code ou state manquant',
  'auth.oidc_invalid_state': 'Paramètre state invalide ou expiré',
  'auth.oidc_token_failed': "Échec de l'échange de jeton",
  'auth.oidc_failed': "Échec de l'authentification OIDC",
  'auth.email_required': "l'adresse e-mail est requise",
  'auth.invalid_email': 'Adresse e-mail invalide',
  'auth.current_password_wrong': 'Mot de passe actuel incorrect',
  'auth.password_too_short': 'Le mot de passe doit contenir au moins 8 caractères',
  'auth.password_changed': 'Mot de passe mis à jour',
  'auth.rate_limited': 'Trop de tentatives, réessayez plus tard',

  'auth.totp_required': 'Code à deux facteurs requis',
  'auth.totp_invalid': 'Code à deux facteurs invalide',
  'auth.totp_disabled_with_oidc': "La double authentification est gérée par votre fournisseur d'identité",
  'auth.totp_already_enabled': 'La double authentification est déjà activée',
  'auth.totp_enabled': 'Double authentification activée',
  'auth.totp_disabled': 'Double authentification désactivée',
  'auth.totp_secret_invalidated': 'Configuration annulée, scannez à nouveau pour obtenir un nouveau secret',

  'auth.reset_requested': 'Si le compte existe, un lien de récupération a été envoyé',
  'auth.reset_sent': 'Lien de récupération envoyé',
  'auth.reset_invalid_token': 'Ce lien de récupération est invalide ou a expiré',
  'auth.reset_done': 'Mot de passe mis à jour, vous pouvez vous connecter',

  'profile.updated': 'Profil mis à jour',
  'profile.avatar_updated': 'Avatar mis à jour',
  'profile.avatar_removed': 'Avatar réinitialisé sur Gravatar',
  'profile.avatar_invalid': "Format d'image non pris en charge",
  'profile.avatar_too_large': "L'image est trop volumineuse",
  'profile.lang_updated': 'Langue mise à jour',
  'profile.theme_updated': 'Thème de couleurs mis à jour',

  'scenario.not_found': 'Scénario introuvable',
  'scenario.invalid_name': 'Nom de scénario invalide',
  'scenario.save_failed': "Échec de l'enregistrement",
  'scenario.import_failed': "Échec de l'import",
  'scenario.not_found_on_disk': 'Scénario introuvable sur le disque',
  'scenario.load_failed': 'Chargement du scénario impossible',
  'scenario.duplicate': 'existe déjà',

  'users.load_failed': 'Chargement des utilisateurs impossible',
  'users.create_failed': "Échec de la création de l'utilisateur",
  'users.role_failed': 'Échec de la mise à jour du rôle',
  'users.password_failed': 'Échec de la mise à jour du mot de passe',
  'users.delete_failed': "Échec de la suppression de l'utilisateur",
  'users.password_set': 'Mot de passe de {name}',
  'users.password_updated': 'Mot de passe mis à jour pour {name}',
  'users.delete_confirm': 'Supprimer {name} ?',

  // ── Errors ─────────────────────────────────────────────────────────────────
  'error.internal': 'Erreur interne du serveur',
  'error.import_unconfigured': "Serveur non configuré pour l'import",
  'error.export_unconfigured': "Serveur non configuré pour l'export",
  'error.yaml_required': 'Contenu YAML requis',
  'error.yaml_field_required': 'Contenu YAML requis dans les champs « yaml » ou « scenarios »',
  'error.name_mismatch': "Le nom du scénario dans le YAML ne correspond pas à l'URL",
  'error.run_unconfigured': 'Serveur non configuré pour les exécutions manuelles',
  'error.not_running': "Le scénario n'est pas en cours d'exécution",
  'error.not_scheduled': 'Scénario introuvable ou non planifié',
  'error.config_export_unconfigured': "Serveur non configuré pour l'export de la configuration",
  'error.config_save_unconfigured': "Serveur non configuré pour l'enregistrement de la configuration",
  'error.config_delete_unconfigured': "Serveur non configuré pour la suppression de la configuration",

  'status.title': '{name} — Statut Scenarii',
  'status.auto_refresh': 'Page de statut — actualisation automatique toutes les 30 s',
  'status.current': 'Statut actuel',
  'status.sla': 'SLA ({days} j)',
  'status.total_runs': 'Exécutions totales',
  'status.passed': 'Réussies',
  'status.failed': 'En échec',
  'status.duration_trend': 'Évolution du temps de réponse',
  'status.success_trend': 'Taux de réussite dans le temps',
  'status.no_runs': 'Aucune exécution pour le moment',
  'status.pass': 'OK',
  'status.fail': 'Échec',
  'status.footer': 'Scenarii',
};

const es: Catalogue = {
  'auth.required': 'Autenticación requerida',
  'auth.admin_required': 'Se requiere el rol de administrador',
  'auth.invalid_credentials': 'Usuario o contraseña incorrectos',
  'auth.password_login_disabled': 'El acceso con contraseña está desactivado',
  'auth.login_failed': 'Error al iniciar sesión',
  'auth.username_required': 'el nombre de usuario es obligatorio',
  'auth.user_exists': 'El usuario ya existe',
  'auth.unknown_user': 'Usuario desconocido',
  'auth.role_required': 'el nombre de usuario y el rol son obligatorios',
  'auth.own_role': 'No puedes cambiar tu propio rol',
  'auth.own_delete': 'No puedes eliminar tu propia cuenta',
  'auth.oidc_not_configured': 'OIDC no configurado',
  'auth.oidc_unreachable': 'Proveedor OIDC inaccesible',
  'auth.oidc_missing_code': 'Falta el parámetro code o state',
  'auth.oidc_invalid_state': 'Parámetro state no válido o caducado',
  'auth.oidc_token_failed': 'Error al intercambiar el token',
  'auth.oidc_failed': 'Error de autenticación OIDC',
  'auth.email_required': 'el correo electrónico es obligatorio',
  'auth.invalid_email': 'Correo electrónico no válido',
  'auth.current_password_wrong': 'La contraseña actual es incorrecta',
  'auth.password_too_short': 'La contraseña debe tener al menos 8 caracteres',
  'auth.password_changed': 'Contraseña actualizada',
  'auth.rate_limited': 'Demasiados intentos, inténtalo más tarde',

  'auth.totp_required': 'Se requiere el código de doble factor',
  'auth.totp_invalid': 'Código de doble factor no válido',
  'auth.totp_disabled_with_oidc': 'La doble autenticación la gestiona tu proveedor de identidad',
  'auth.totp_already_enabled': 'La doble autenticación ya está activada',
  'auth.totp_enabled': 'Doble autenticación activada',
  'auth.totp_disabled': 'Doble autenticación desactivada',
  'auth.totp_secret_invalidated': 'Configuración cancelada, escanea de nuevo para obtener un secreto nuevo',

  'auth.reset_requested': 'Si la cuenta existe, se ha enviado un enlace de recuperación',
  'auth.reset_sent': 'Enlace de recuperación enviado',
  'auth.reset_invalid_token': 'Este enlace de recuperación no es válido o ha caducado',
  'auth.reset_done': 'Contraseña actualizada, ya puedes iniciar sesión',

  'profile.updated': 'Perfil actualizado',
  'profile.avatar_updated': 'Avatar actualizado',
  'profile.avatar_removed': 'Avatar restablecido a Gravatar',
  'profile.avatar_invalid': 'Formato de imagen no compatible',
  'profile.avatar_too_large': 'La imagen es demasiado grande',
  'profile.lang_updated': 'Idioma actualizado',
  'profile.theme_updated': 'Esquema de color actualizado',

  'scenario.not_found': 'Escenario no encontrado',
  'scenario.invalid_name': 'Nombre de escenario no válido',
  'scenario.save_failed': 'Error al guardar',
  'scenario.import_failed': 'Error al importar',
  'scenario.not_found_on_disk': 'Escenario no encontrado en disco',
  'scenario.load_failed': 'No se pudo cargar la configuración del escenario',
  'scenario.duplicate': 'ya existe',

  'users.load_failed': 'No se pudieron cargar los usuarios',
  'users.create_failed': 'Error al crear el usuario',
  'users.role_failed': 'Error al actualizar el rol',
  'users.password_failed': 'Error al actualizar la contraseña',
  'users.delete_failed': 'Error al eliminar el usuario',
  'users.password_set': 'Contraseña de {name}',
  'users.password_updated': 'Contraseña actualizada para {name}',
  'users.delete_confirm': '¿Eliminar a {name}?',

  // ── Errors ─────────────────────────────────────────────────────────────────
  'error.internal': 'Error interno del servidor',
  'error.import_unconfigured': 'Servidor no configurado para importar',
  'error.export_unconfigured': 'Servidor no configurado para exportar',
  'error.yaml_required': 'Se requiere contenido YAML',
  'error.yaml_field_required': 'Se requiere contenido YAML en los campos «yaml» o «scenarios»',
  'error.name_mismatch': 'El nombre del escenario en el YAML no coincide con la URL',
  'error.run_unconfigured': 'Servidor no configurado para ejecuciones manuales',
  'error.not_running': 'El escenario no se está ejecutando',
  'error.not_scheduled': 'Escenario no encontrado o no programado',
  'error.config_export_unconfigured': 'Servidor no configurado para exportar la configuración',
  'error.config_save_unconfigured': 'Servidor no configurado para guardar la configuración',
  'error.config_delete_unconfigured': 'Servidor no configurado para eliminar la configuración',

  'status.title': '{name} — Estado de Scenarii',
  'status.auto_refresh': 'Página de estado — se actualiza cada 30 s',
  'status.current': 'Estado actual',
  'status.sla': 'SLA ({days} d)',
  'status.total_runs': 'Ejecuciones totales',
  'status.passed': 'Correctas',
  'status.failed': 'Fallidas',
  'status.duration_trend': 'Evolución del tiempo de respuesta',
  'status.success_trend': 'Tasa de éxito en el tiempo',
  'status.no_runs': 'Todavía no hay ejecuciones',
  'status.pass': 'Correcto',
  'status.fail': 'Fallo',
  'status.footer': 'Scenarii',
};

const de: Catalogue = {
  'auth.required': 'Authentifizierung erforderlich',
  'auth.admin_required': 'Administratorrolle erforderlich',
  'auth.invalid_credentials': 'Benutzername oder Passwort falsch',
  'auth.password_login_disabled': 'Passwortanmeldung ist deaktiviert',
  'auth.login_failed': 'Anmeldung fehlgeschlagen',
  'auth.username_required': 'Benutzername ist erforderlich',
  'auth.user_exists': 'Benutzer existiert bereits',
  'auth.unknown_user': 'Unbekannter Benutzer',
  'auth.role_required': 'Benutzername und Rolle sind erforderlich',
  'auth.own_role': 'Die eigene Rolle kann nicht geändert werden',
  'auth.own_delete': 'Das eigene Konto kann nicht gelöscht werden',
  'auth.oidc_not_configured': 'OIDC nicht konfiguriert',
  'auth.oidc_unreachable': 'OIDC-Anbieter nicht erreichbar',
  'auth.oidc_missing_code': 'Parameter code oder state fehlt',
  'auth.oidc_invalid_state': 'Parameter state ungültig oder abgelaufen',
  'auth.oidc_token_failed': 'Token-Austausch fehlgeschlagen',
  'auth.oidc_failed': 'OIDC-Authentifizierung fehlgeschlagen',
  'auth.email_required': 'E-Mail-Adresse ist erforderlich',
  'auth.invalid_email': 'Ungültige E-Mail-Adresse',
  'auth.current_password_wrong': 'Aktuelles Passwort ist falsch',
  'auth.password_too_short': 'Das Passwort muss mindestens 8 Zeichen haben',
  'auth.password_changed': 'Passwort aktualisiert',
  'auth.rate_limited': 'Zu viele Versuche, bitte später erneut probieren',

  'auth.totp_required': 'Zwei-Faktor-Code erforderlich',
  'auth.totp_invalid': 'Ungültiger Zwei-Faktor-Code',
  'auth.totp_disabled_with_oidc': 'Die Zwei-Faktor-Authentifizierung wird vom Identitätsanbieter verwaltet',
  'auth.totp_already_enabled': 'Die Zwei-Faktor-Authentifizierung ist bereits aktiviert',
  'auth.totp_enabled': 'Zwei-Faktor-Authentifizierung aktiviert',
  'auth.totp_disabled': 'Zwei-Faktor-Authentifizierung deaktiviert',
  'auth.totp_secret_invalidated': 'Einrichtung abgebrochen, erneut scannen für ein neues Geheimnis',

  'auth.reset_requested': 'Falls das Konto existiert, wurde ein Wiederherstellungslink gesendet',
  'auth.reset_sent': 'Wiederherstellungslink gesendet',
  'auth.reset_invalid_token': 'Dieser Wiederherstellungslink ist ungültig oder abgelaufen',
  'auth.reset_done': 'Passwort aktualisiert, du kannst dich jetzt anmelden',

  'profile.updated': 'Profil aktualisiert',
  'profile.avatar_updated': 'Avatar aktualisiert',
  'profile.avatar_removed': 'Avatar auf Gravatar zurückgesetzt',
  'profile.avatar_invalid': 'Nicht unterstütztes Bildformat',
  'profile.avatar_too_large': 'Bild ist zu groß',
  'profile.lang_updated': 'Sprache aktualisiert',
  'profile.theme_updated': 'Farbschema aktualisiert',

  'scenario.not_found': 'Szenario nicht gefunden',
  'scenario.invalid_name': 'Ungültiger Szenario-Name',
  'scenario.save_failed': 'Speichern fehlgeschlagen',
  'scenario.import_failed': 'Import fehlgeschlagen',
  'scenario.not_found_on_disk': 'Szenario nicht auf der Festplatte gefunden',
  'scenario.load_failed': 'Szenario-Konfiguration konnte nicht geladen werden',
  'scenario.duplicate': 'existiert bereits',

  'users.load_failed': 'Benutzer konnten nicht geladen werden',
  'users.create_failed': 'Benutzer konnte nicht erstellt werden',
  'users.role_failed': 'Rolle konnte nicht aktualisiert werden',
  'users.password_failed': 'Passwort konnte nicht aktualisiert werden',
  'users.delete_failed': 'Benutzer konnte nicht gelöscht werden',
  'users.password_set': 'Passwort für {name}',
  'users.password_updated': 'Passwort für {name} aktualisiert',
  'users.delete_confirm': 'Benutzer {name} löschen?',

  // ── Errors ─────────────────────────────────────────────────────────────────
  'error.internal': 'Interner Serverfehler',
  'error.import_unconfigured': 'Server ist nicht für den Import konfiguriert',
  'error.export_unconfigured': 'Server ist nicht für den Export konfiguriert',
  'error.yaml_required': 'YAML-Inhalt erforderlich',
  'error.yaml_field_required': 'YAML-Inhalt im Feld „yaml“ oder „scenarios“ erforderlich',
  'error.name_mismatch': 'Der Szenario-Name im YAML stimmt nicht mit der URL überein',
  'error.run_unconfigured': 'Server ist nicht für manuelle Läufe konfiguriert',
  'error.not_running': 'Szenario läuft derzeit nicht',
  'error.not_scheduled': 'Szenario nicht gefunden oder nicht geplant',
  'error.config_export_unconfigured': 'Server ist nicht für den Konfigurationsexport konfiguriert',
  'error.config_save_unconfigured': 'Server ist nicht für das Speichern der Konfiguration konfiguriert',
  'error.config_delete_unconfigured': 'Server ist nicht für das Löschen der Konfiguration konfiguriert',

  'status.title': '{name} — Scenarii Status',
  'status.auto_refresh': 'Statusseite — Aktualisierung alle 30 s',
  'status.current': 'Aktueller Status',
  'status.sla': 'SLA ({days} T)',
  'status.total_runs': 'Läufe insgesamt',
  'status.passed': 'Erfolgreich',
  'status.failed': 'Fehlgeschlagen',
  'status.duration_trend': 'Verlauf der Antwortzeit',
  'status.success_trend': 'Erfolgsquote im Verlauf',
  'status.no_runs': 'Noch keine Läufe',
  'status.pass': 'OK',
  'status.fail': 'Fehler',
  'status.footer': 'Scenarii',
};

const CATALOGUES: Record<Lang, Catalogue> = { en, fr, es, de };

// Coerces anything into a supported language, defaulting to English.
export function normalizeLang(value: unknown): Lang {
  return typeof value === 'string' && (LANGS as string[]).includes(value) ? value as Lang : DEFAULT_LANG;
}

// Picks the best supported language from an Accept-Language header value.
export function langFromAcceptLanguage(header: string | undefined): Lang {
  if (!header) return DEFAULT_LANG;
  const wanted = header
    .split(',')
    .map(part => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: (tag || '').trim().toLowerCase(), q: q ? parseFloat(q) || 0 : 1 };
    })
    .filter(item => item.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    if ((LANGS as string[]).includes(tag)) return tag as Lang;
    const base = tag.split('-')[0];
    if ((LANGS as string[]).includes(base)) return base as Lang;
  }
  return DEFAULT_LANG;
}

// Translates a message id. Unknown ids return themselves, which makes a missing
// translation obvious in the UI instead of rendering an empty string.
export function t(key: string, lang: Lang = DEFAULT_LANG, params?: Record<string, string | number>): string {
  const message = CATALOGUES[lang]?.[key] ?? CATALOGUES[DEFAULT_LANG][key] ?? key;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]));
}

// Every message id of the source language, used by tests to check parity.
export function messageIds(): string[] {
  return Object.keys(CATALOGUES[DEFAULT_LANG]);
}

// True when the catalogue for a language covers every source message.
export function isComplete(lang: Lang): boolean {
  return Object.keys(CATALOGUES[DEFAULT_LANG]).every(key => key in CATALOGUES[lang]);
}