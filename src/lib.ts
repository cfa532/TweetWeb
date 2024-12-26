function formatTimeDifference(t: number) {
    const now = Date.now(); // Current timestamp in milliseconds
    const diffInMilliseconds = now - t; // Difference in milliseconds

    // Convert milliseconds to various units
    const diffInSeconds = Math.floor(diffInMilliseconds / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInWeeks = Math.floor(diffInDays / 7);
    const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
    const diffInYears = Math.floor(diffInDays / 365.25); // Average days in a year accounting for leap years

    // Determine the appropriate unit to display
    if (diffInSeconds < 60) {
        return `${diffInSeconds} seconds ago`;
    } else if (diffInMinutes < 60) {
        return `${diffInMinutes+1} minutes ago`;
    } else if (diffInHours < 24) {
        return `${diffInHours+1} hours ago`;
    } else if (diffInDays < 7) {
        return `${diffInDays+1} days ago`;
    } else if (diffInWeeks < 4) {
        return `${diffInWeeks+1} weeks ago`;
    } else if (diffInMonths < 12) {
        return `${diffInMonths+1} months ago`;
    } else {
        return `${diffInYears+1} years ago`;
    }
}

export { formatTimeDifference }