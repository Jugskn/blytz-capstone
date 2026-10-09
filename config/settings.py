"""
Django settings for Blytz (config project).
"""

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, True),
    PAYMENT_WINDOW_MINUTES=(int, 10),
)

environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env(
    "SECRET_KEY",
    default="django-insecure-change-me-in-production",
)

DEBUG = env("DEBUG")

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Behind Railway / reverse proxies that terminate TLS
if env.bool("USE_SECURE_PROXY_SSL_HEADER", default=False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
elif env("SECURE_PROXY_SSL_HEADER", default=""):
    # Format: HTTP_X_FORWARDED_PROTO,https
    _header, _, _value = env("SECURE_PROXY_SSL_HEADER").partition(",")
    if _header and _value:
        SECURE_PROXY_SSL_HEADER = (_header.strip(), _value.strip())

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.sites",
    # Third-party
    "allauth",
    "allauth.account",
    "django_tailwind_cli",
    # Local apps
    "apps.accounts",
    "apps.core",
    "apps.designs",
    "apps.orders",
    "apps.accounting",
    "apps.sales",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "apps.core.context_processors.blytz",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# Database — SQLite by default; set DATABASE_URL for MySQL later
DATABASES = {
    "default": env.db(
        "DATABASE_URL",
        default=f"sqlite:///{(BASE_DIR / 'db.sqlite3').as_posix()}",
    )
}

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# Static & media
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": (
            "django.contrib.staticfiles.storage.StaticFilesStorage"
            if DEBUG
            else "whitenoise.storage.CompressedManifestStaticFilesStorage"
        ),
    },
}

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Tailwind (django-tailwind-cli) — theme tokens live in src/styles/main.css
TAILWIND_CLI_SRC_CSS = "src/styles/main.css"
TAILWIND_CLI_DIST_CSS = "css/tailwind.css"

# Blytz business settings
MESSENGER_PAGE_USERNAME = env("MESSENGER_PAGE_USERNAME", default="")
PAYMENT_WINDOW_MINUTES = env("PAYMENT_WINDOW_MINUTES")

# Email — console in development; set EMAIL_BACKEND to anymail later, e.g.
# EMAIL_BACKEND=anymail.backends.mailgun.EmailBackend (+ django-anymail + provider keys)
EMAIL_BACKEND = env(
    "EMAIL_BACKEND",
    default="django.core.mail.backends.console.EmailBackend",
)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="noreply@blytz.local")
ANYMAIL = {
    # Populated when switching to an HTTPS email provider via django-anymail
}

# Sites / allauth
SITE_ID = 1

AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]

ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_ADAPTER = "apps.accounts.adapters.AccountAdapter"
ACCOUNT_FORMS = {
    "signup": "apps.accounts.forms.BlytzSignupForm",
}
ACCOUNT_LOGOUT_ON_GET = True
LOGIN_REDIRECT_URL = "/app/"
ACCOUNT_LOGOUT_REDIRECT_URL = "/"
LOGIN_URL = "account_login"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
