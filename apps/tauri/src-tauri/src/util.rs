//! Small helpers shared across desktop host modules.

use std::time::{SystemTime, UNIX_EPOCH};

/// Formats `time` as an RFC 3339 UTC timestamp.
///
/// Implemented with Howard Hinnant's civil-date algorithm rather than a
/// formatting crate so the host stays dependency-free here; the same routine is
/// exercised by the unit tests below against known epoch values.
pub(crate) fn rfc3339(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Converts days since the Unix epoch into a `(year, month, day)` triple.
pub(crate) fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn known_epochs_format_correctly() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            "2023-11-14T22:13:20Z"
        );
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_secs(86_400)),
            "1970-01-02T00:00:00Z"
        );
    }

    #[test]
    fn leap_year_and_year_boundary() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024 is a leap year: 2024-02-29 is day 19,782 since epoch.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        // 2024-03-01 is the day after, so a leap day must not shift March.
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        // 2023-12-31 -> 2024-01-01 year boundary.
        assert_eq!(civil_from_days(19_722), (2023, 12, 31));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn pre_epoch_dates_are_supported() {
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(-365), (1969, 1, 1));
    }
}
