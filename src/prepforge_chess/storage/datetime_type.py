"""UTC instants on both PostgreSQL and SQLite."""
from datetime import timezone

from sqlalchemy import DateTime
from sqlalchemy.dialects.sqlite import DATETIME
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "sqlite":
            # Let SQLite's ISO parser produce aware UTC directly, avoiding a
            # datetime allocation to attach tzinfo for every returned value.
            return dialect.type_descriptor(DATETIME(storage_format=(
                "%(year)04d-%(month)02d-%(day)02d %(hour)02d:%(minute)02d:"
                "%(second)02d.%(microsecond)06d+00:00"
            )))
        return dialect.type_descriptor(self.impl)

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Persisted timestamps must be timezone-aware")
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None or value.tzinfo is timezone.utc:
            return value
        return value.astimezone(timezone.utc)
