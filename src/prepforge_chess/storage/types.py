"""Schema value types."""
import enum

class Plan(str, enum.Enum):
    free = "free"
    pro = "pro"

class TeamRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"
