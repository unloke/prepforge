from prepforge_chess.api.deps import member_name


def test_member_without_display_name_is_named_by_email():
    assert member_name("Alice", "a@example.com") == "Alice"
    assert member_name(None, "qa3@example.com") == "qa3"
    assert member_name(None, None) == "Former member"
