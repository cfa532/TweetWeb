<?php

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $to = $_POST['to'];
    $subject = $_POST['subject'];
    $message = $_POST['message'];

    if (empty($to) || empty($subject) || empty($message)) {
        echo '<p style="color: red;">Please fill in all fields.</p>';
    } else {
        // Validate email address
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
            echo '<p style="color: red;">Invalid email format.</p>';
        } else {
            // Set headers
            $headers = "From: www-data@fireshare.us\r\n";
            $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

            // Send the email
            if (mail($to, $subject, $message, $headers)) {
                echo '<p style="color: green;">Email sent successfully!</p>';
            } else {
                echo '<p style="color: red;">Error sending email.</p>';
            }
        }
    }
}

?>

<!DOCTYPE html>
<html>
<head>
    <title>Send Email</title>
    <style>
        body { font-family: sans-serif; }
        label { display: block; margin-top: 10px; }
        input[type="text"], input[type="email"], textarea {
            width: 300px;
            padding: 5px;
            margin-bottom: 10px;
        }
        input[type="submit"] {
            background-color: #4CAF50;
            color: white;
            padding: 10px 15px;
            border: none;
            cursor: pointer;
        }
        input[type="submit"]:hover {
            background-color: #3e8e41;
        }
    </style>
</head>
<body>
    <h1>Send Email</h1>
    <form method="post">
        <label for="to">To:</label>
        <input type="email" id="to" name="to" value="cfa532@yahoo.com" readonly><br>

        <label for="subject">Subject:</label>
        <input type="text" id="subject" name="subject" value="Delete account" readonly><br>

        <label for="message">Message:</label>
        <textarea id="message" name="message" rows="4" cols="50" required></textarea><br>

        <input type="submit" value="Send Email">
    </form>
    <div>
        <p>Please provide your username and host Id in the message</p>
    </div>
</body>
</html>
