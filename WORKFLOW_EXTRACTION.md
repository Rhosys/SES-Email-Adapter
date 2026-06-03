# Email Action Types — Master Reference

44 distinct action types across all major email clients.
Each entry includes a description, data fields to extract, and a concrete usage example.

---

## In-Email Interactive Actions
*The recipient takes an action without leaving the inbox — buttons, forms, or cards embedded in the email itself.*

---

### 1. One-Click Confirm
A button in the inbox list or email body that fires a confirmation signal to the sender's server. No browser navigation. Single-use.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `confirmation_url` | URL | Endpoint to POST to on click |
| `token` | string | Unique confirmation token; must be in URL or POST body |
| `token_expiry` | datetime (optional) | When the token becomes invalid |
| `confirmation_type` | enum: `email_verify` \| `subscription` \| `approval` \| `account_activation` | What is being confirmed |
| `button_label` | string (optional) | Text to display on the button, e.g. "Confirm your email" |

**Example:**
A user registers on a SaaS platform. They receive a welcome email with a "Confirm your email" button visible directly in their Gmail inbox list — no need to open the email. Clicking it sends a POST to `https://app.example.com/confirm?token=abc123`. The account is activated instantly.

---

### 2. Approve / Reject
A two-option decision card embedded in the email. The card refreshes to show the updated state once a choice is made. Designed for multi-step business sign-off chains.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `request_id` | string | Unique ID of the item being decided on |
| `request_type` | enum: `expense` \| `access` \| `purchase_order` \| `leave` \| `contract` \| `other` | Category of the request |
| `requester_name` | string | Display name of who submitted the request |
| `requester_email` | string | |
| `subject_summary` | string | Human-readable label, e.g. "Travel to Berlin — $340" |
| `amount` | decimal (optional) | If the request involves a financial value |
| `currency` | string (optional) | ISO 4217 code, e.g. "USD" |
| `approve_endpoint` | URL | POST target when Approve is clicked |
| `reject_endpoint` | URL | POST target when Reject is clicked |
| `card_refresh_url` | URL (optional) | Fetch updated card state after action completes |

**Example:**
A manager receives an expense report submission. The email contains an embedded card showing the submitter's name, amount ($340), and category (Travel). Two buttons: **Approve** and **Reject**. Clicking Approve calls the expense system API, marks the report approved, and the card updates to show "Approved by you on May 21".

---

### 3. Vote / Poll
A multi-option selection embedded in the email. Responses are aggregated server-side. The card can display live results after the recipient votes.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `poll_id` | string | Unique ID for this poll instance |
| `question` | string | The question being asked |
| `options` | array of `{ id: string, label: string }` | Selectable choices |
| `multi_select` | boolean | Whether multiple options can be chosen |
| `vote_endpoint` | URL | POST target for the selected option(s) |
| `results_endpoint` | URL (optional) | Fetch live result data after voting |
| `deadline` | datetime (optional) | When voting closes |
| `show_results_after_vote` | boolean | Whether to display aggregate results post-vote |

**Example:**
A team lead sends a meeting scheduling email with an embedded poll: "Which time works for you?" showing three options (Mon 10am / Tue 2pm / Wed 9am). Each team member clicks their preference directly in the email. After voting, the card updates to show a live bar chart of responses.

---

### 4. RSVP
An inline accept / maybe / decline response to an event invitation. On acceptance, the event is automatically added to the recipient's calendar.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `event_id` | string | Unique identifier for the event |
| `event_name` | string | |
| `event_start` | datetime | ISO 8601 with timezone |
| `event_end` | datetime (optional) | |
| `location` | string (optional) | Address or virtual meeting URL |
| `organiser_name` | string | |
| `organiser_email` | string | |
| `rsvp_endpoint` | URL | POST with `{ response: "accept" | "maybe" | "decline" }` |
| `calendar_add_url` | URL (optional) | ICS file URL or calendar deep-link |
| `response_options` | array of enum: `accept` \| `maybe` \| `decline` | Which buttons to surface |
| `attendee_count` | integer (optional) | Current accepted count, for social context |

**Example:**
A user receives a conference invitation email. The email shows event details and three inline buttons: **Going**, **Maybe**, **Can't attend**. Clicking **Going** adds the event to their Google Calendar and sends an acceptance back to the organiser — without opening any other app or page.

---

### 5. Flight Check-In
A button surfaced from a booking confirmation email that initiates or completes online check-in for a flight. Fires directly to the airline's check-in endpoint.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `airline_name` | string | |
| `airline_iata_code` | string | e.g. "BA" |
| `flight_number` | string | e.g. "BA256" |
| `departure_datetime` | datetime | |
| `departure_airport_iata` | string | e.g. "LHR" |
| `arrival_airport_iata` | string | e.g. "JFK" |
| `booking_reference` | string | PNR / locator code |
| `passenger_name` | string | As it appears on the booking |
| `checkin_url` | URL | Airline check-in deep-link, pre-filled where possible |
| `checkin_opens` | datetime (optional) | When check-in window opens |
| `checkin_closes` | datetime (optional) | Check-in deadline |
| `seat_number` | string (optional) | Pre-assigned seat if known |

**Example:**
24 hours before departure, a user receives a check-in reminder email from Lufthansa. Instead of navigating to the airline website, they see a **Check In** button directly in Gmail. Clicking it submits their check-in via the airline API and returns a boarding pass.

---

### 6. Save Offer / Coupon
A single-use button that saves a discount code or offer to the user's account. Once clicked, the button becomes inactive — preventing duplicate redemptions from email.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `offer_code` | string | The actual discount code |
| `offer_description` | string | e.g. "20% off your next order" |
| `discount_type` | enum: `percentage` \| `fixed_amount` \| `free_shipping` \| `buy_x_get_y` | |
| `discount_value` | string | "20%" or "£10" |
| `valid_from` | datetime (optional) | |
| `valid_until` | datetime | Expiry — required to show urgency |
| `minimum_order_value` | decimal (optional) | Threshold to apply the discount |
| `save_endpoint` | URL | POST to store the offer against the user's session/account |
| `terms_url` | URL (optional) | Link to full terms |

**Example:**
A retail brand sends a Black Friday email with a 20% off code. Instead of copying the code manually, the user sees a **Save to my account** button. Clicking it stores the code against their logged-in session, ready to apply at checkout. The button then shows "Saved".

---

### 7. Add to Queue / Playlist
A variant of Save for media: save a song, podcast, or video to a playback queue directly from a promotional or notification email.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `item_id` | string | Platform-specific ID |
| `item_title` | string | |
| `item_type` | enum: `song` \| `album` \| `podcast_episode` \| `video` \| `playlist` | |
| `artist_or_creator` | string (optional) | |
| `platform` | string | e.g. "Spotify", "Apple Music", "YouTube" |
| `item_url` | URL | Canonical URL on the platform |
| `add_to_queue_endpoint` | URL | API endpoint to add item to the active queue |
| `thumbnail_url` | URL (optional) | Album art or thumbnail |
| `duration_seconds` | integer (optional) | |

**Example:**
Spotify sends a "New release from an artist you follow" email. The email contains an **Add to queue** button. Clicking it adds the album to the user's active Spotify queue without opening the app or website.

---

### 8. Rate & Review
An inline star rating widget and optional text field. The recipient submits a review without visiting the sender's website.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `item_id` | string | ID of the product or service being reviewed |
| `item_name` | string | |
| `item_type` | enum: `product` \| `hotel` \| `restaurant` \| `service` \| `app` \| `event` | |
| `purchase_or_visit_date` | date (optional) | Provides context for the reviewer |
| `rating_min` | integer | Default 1 |
| `rating_max` | integer | Default 5 |
| `review_endpoint` | URL | POST endpoint for the submitted rating and text |
| `fields` | array of `{ name, label, type: text \| textarea, required }` | Additional form fields alongside the star rating |
| `image_upload_allowed` | boolean (optional) | Whether the reviewer can attach a photo |

**Example:**
After a hotel stay, the guest receives a post-checkout email. The email body contains a 1–5 star selector and a text box. The guest selects 4 stars, writes "Great location, slow check-in", and clicks **Submit Review** — all within the email. The review posts to the hotel's review system.

---

### 9. Survey / Form
A fully functional form inside the email body — text inputs, dropdowns, date pickers, checkboxes. Responses submit to the sender's backend. The email can update after submission to show a confirmation state.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `form_id` | string | |
| `form_title` | string | |
| `fields` | array of `{ id, label, type: text \| textarea \| radio \| checkbox \| select \| date \| number \| rating, options[], required, placeholder }` | Full field spec for each question |
| `submission_endpoint` | URL | POST with collected field values |
| `deadline` | datetime (optional) | When the form closes |
| `confirmation_message` | string | Shown after submission |
| `success_state_content` | string (optional) | HTML/text to replace the form on the page after submit |
| `allow_edit_after_submit` | boolean | Whether the respondent can go back and change answers |

**Example:**
An HR team sends an annual engagement survey via email. The email contains a 6-question inline form with radio buttons and a text area. The employee fills it out and clicks **Submit** without visiting any external URL. The email body then transitions to a "Thank you, your response was recorded" state.

---

### 10. View Reservation / Booking
A one-click button that deep-links directly to the specific booking page — not the homepage — for a flight, hotel, or order.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `booking_type` | enum: `flight` \| `hotel` \| `car_rental` \| `train` \| `bus` \| `event` \| `restaurant` \| `cruise` | |
| `booking_reference` | string | Confirmation or reservation number |
| `booking_url` | URL | Direct deep-link — must resolve to the specific booking, not a homepage |
| `provider_name` | string | e.g. "Booking.com", "Hertz", "OpenTable" |
| `booking_date` | date (optional) | When the reservation was made |

**Example:**
A user receives a hotel confirmation email. Instead of searching their inbox for the booking reference and navigating to the hotel site, a **View booking** button takes them directly to `hotels.example.com/bookings/RES-4921` with their reservation pre-loaded.

---

### 11. Track Package
A one-click button that opens the carrier's tracking page for that specific shipment, pre-filled with the tracking number extracted from the email.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `carrier_name` | string | e.g. "DHL", "FedEx", "Royal Mail", "UPS" |
| `carrier_code` | string (optional) | Standardised carrier identifier |
| `tracking_number` | string | |
| `tracking_url` | URL | Direct tracking page with number pre-filled |
| `order_id` | string (optional) | Sender's internal order ID |
| `estimated_delivery_date` | date (optional) | |
| `ship_from_location` | string (optional) | Origin city / country |
| `ship_to_location` | string (optional) | Destination city / country |

**Example:**
A user receives a dispatch notification from an online shop. The email shows a **Track your order** button. Clicking it opens DHL's tracking page at `dhl.com/track?id=1234567890` — no manual entry of the tracking number.

---

### 12. Password-Protected Delivery
The sender encrypts the message body. The recipient receives a link. They must enter a pre-shared password to decrypt and read the contents. Works to any email address.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `secure_message_url` | URL | Link to the secure message viewer |
| `sender_name` | string | |
| `sender_email` | string | |
| `expires_at` | datetime (optional) | When the secure link becomes invalid |
| `auth_method` | enum: `shared_password` \| `date_of_birth` \| `phone_otp` \| `pin` | How the recipient authenticates |
| `hint` | string (optional) | Password hint visible before authentication |
| `message_preview` | string (optional) | Safe subject or summary shown before auth — no sensitive content |
| `max_view_count` | integer (optional) | How many times the link can be opened |

**Example:**
A lawyer sends a client their signed contract. Rather than attaching a PDF, they send an encrypted email. The client receives a message: "You have a secure message from J. Smith. Click here to read it." They enter the password agreed on a phone call, and the contract displays in a secure web view.

---

## Informational Callouts
*The email client extracts structured data and surfaces it — no sender interaction required, no click needed from the recipient.*

---

### 13. Flight Highlights
The client reads structured data in the email and surfaces flight details — airline, flight number, departure/arrival airports, times — as chips or a card shown above the email body.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `airline_name` | string | |
| `airline_iata_code` | string | e.g. "BA" |
| `flight_number` | string | e.g. "BA256" |
| `departure_airport_iata` | string | |
| `departure_airport_name` | string | Full name, e.g. "London Heathrow" |
| `departure_city` | string | |
| `arrival_airport_iata` | string | |
| `arrival_airport_name` | string | |
| `arrival_city` | string | |
| `departure_datetime` | datetime | ISO 8601 with timezone |
| `arrival_datetime` | datetime | |
| `booking_reference` | string | PNR / locator code |
| `seat_number` | string (optional) | |
| `cabin_class` | enum: `economy` \| `premium_economy` \| `business` \| `first` (optional) | |
| `destination_image_url` | URL (optional) | Hero image of destination city |

**Example:**
A user receives a flight confirmation from British Airways. Before they even open the email, Gmail shows a card beneath the subject line: "BA 256 · LHR → JFK · 22 May, 09:15 → 12:30". No interaction needed — the data is simply there.

---

### 14. Hotel Reservation Highlights
Extracts check-in date, check-out date, property name, and confirmation number from a booking email and surfaces them as a card.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `property_name` | string | |
| `property_address` | string | Full address |
| `check_in_date` | date | |
| `check_in_time` | time (optional) | Standard check-in time |
| `check_out_date` | date | |
| `check_out_time` | time (optional) | |
| `number_of_nights` | integer | Derived from check-in/out dates |
| `confirmation_number` | string | |
| `room_type` | string (optional) | e.g. "Deluxe Double" |
| `number_of_guests` | integer (optional) | |
| `total_cost` | decimal (optional) | |
| `currency` | string (optional) | ISO 4217 |
| `property_image_url` | URL (optional) | |

**Example:**
A Booking.com confirmation lands in a user's inbox. Gmail shows a chip: "Marriott Edinburgh · Check-in 24 May · Check-out 27 May · Ref: BK-88231". The user sees all the information they need without opening the email.

---

### 15. Transportation Highlights (Bus / Train / Car Rental)
Same extraction as hotel/flight but for ground transport: departure point, arrival point, times, booking reference.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `transport_type` | enum: `bus` \| `train` \| `car_rental` \| `ferry` \| `taxi` | |
| `operator_name` | string | e.g. "Eurostar", "Enterprise", "National Express" |
| `departure_location` | string | Station name or address |
| `arrival_location` | string | |
| `departure_datetime` | datetime | |
| `arrival_datetime` | datetime | |
| `booking_reference` | string | |
| `vehicle_details` | string (optional) | For car rental: "Toyota Corolla or similar" |
| `pickup_address` | string (optional) | For car rental pickup |
| `dropoff_address` | string (optional) | |
| `journey_duration_minutes` | integer (optional) | |

**Example:**
A user books a Eurostar train. The confirmation email is parsed and Gmail surfaces: "Eurostar · London St Pancras → Paris Gare du Nord · 25 May, 07:04 → 10:26 · Ref: EUR-3391".

---

### 16. Order Highlights
Extracts and surfaces order details — item image, cost, estimated delivery date — as chips above the email.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `order_id` | string | |
| `order_date` | date | |
| `merchant_name` | string | |
| `item_name` | string | Primary item or a summary, e.g. "3 items" |
| `item_image_url` | URL (optional) | Thumbnail of the primary item |
| `item_count` | integer (optional) | Total number of items in the order |
| `order_total` | decimal | |
| `currency` | string | ISO 4217 |
| `estimated_delivery_date` | date (optional) | |
| `order_status` | enum: `confirmed` \| `processing` \| `shipped` \| `delivered` \| `cancelled` (optional) | |

**Example:**
An Amazon order confirmation arrives. Without opening the email, the user sees: "[product image thumbnail] · £49.99 · Estimated delivery: 23 May".

---

### 17. Real-Time Shipment Status Badge
A live status indicator shown in the inbox that updates automatically as the package moves through carrier checkpoints — without re-opening the email.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `carrier_name` | string | |
| `tracking_number` | string | |
| `current_status` | enum: `label_created` \| `in_transit` \| `out_for_delivery` \| `delivered` \| `exception` \| `returned` | |
| `status_description` | string | Human-readable status, e.g. "Arrived at sorting facility" |
| `last_checkpoint_datetime` | datetime | When the status last changed |
| `last_checkpoint_location` | string (optional) | |
| `estimated_delivery_date` | date (optional) | |
| `status_polling_endpoint` | URL | Endpoint the client calls to refresh live status |
| `polling_interval_seconds` | integer (optional) | How frequently to poll; default 3600 |

**Example:**
A user ordered a laptop. The dispatch email has a real-time badge. On Monday it shows "In transit". By Wednesday it shows "Out for delivery". By 2pm it shows "Delivered". The user never re-opens the email — the inbox row itself reflects live carrier data.

---

### 18. Event Highlights
Surfaces event details — venue, date, time, seat number — as a card shown above the email body.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `event_name` | string | |
| `performer_name` | string (optional) | Artist, speaker, or team |
| `venue_name` | string | |
| `venue_address` | string | |
| `event_start_datetime` | datetime | |
| `event_end_datetime` | datetime (optional) | |
| `ticket_reference` | string | Booking / order reference |
| `seat_details` | string (optional) | e.g. "Block C, Row 12, Seat 4–5" |
| `ticket_count` | integer (optional) | |
| `event_image_url` | URL (optional) | Poster or venue image |

**Example:**
A user buys tickets to a concert via Ticketmaster. The confirmation email is parsed and Gmail shows: "The National · O2 Arena, London · 30 May, 19:30 · Seats: Block C, Row 12, Seat 4–5".

---

### 19. Verification Code Callout
The email client detects a one-time code (OTP, 2FA, confirmation PIN) and surfaces it prominently — as a chip, autofill suggestion, or callout — so the user does not have to search for it.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `code_value` | string | The exact code to surface |
| `code_type` | enum: `otp` \| `2fa_code` \| `pin` \| `confirmation_code` \| `magic_link_code` | |
| `issuer_name` | string | Service that sent the code |
| `expires_at` | datetime (optional) | Absolute expiry |
| `expires_in_seconds` | integer (optional) | Relative expiry, e.g. 600 for "expires in 10 minutes" |
| `purpose` | string (optional) | Human-readable context, e.g. "Use this code to complete your login" |

**Example:**
A user is logging into their bank on mobile. The 6-digit SMS-style code arrives by email instead. Before the user switches apps, iOS surfaces the code as a keyboard autofill suggestion: "From Mail: 847291". One tap fills the field.

---

### 20. Add to Calendar (Auto)
The client detects an event in any confirmation email and offers to add it to the calendar without any markup from the sender — parsing natural language or common patterns.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `event_name` | string | |
| `event_start_datetime` | datetime | |
| `event_end_datetime` | datetime (optional) | |
| `location` | string (optional) | Physical address or video call URL |
| `description` | string (optional) | Notes or agenda |
| `organiser_name` | string (optional) | |
| `organiser_email` | string (optional) | |
| `calendar_url` | URL (optional) | ICS download link or calendar deep-link |
| `recurrence_rule` | string (optional) | RRULE string for recurring events |
| `timezone` | string | IANA timezone identifier |

**Example:**
A user receives a calendar invite in plain text: "Team offsite — Friday 6 June, 10am, Shoreditch Works, London." Apple Mail detects it and shows an "Add to Calendar" banner above the email body.

---

### 21. Boarding Pass / Wallet Import
The email client detects a boarding pass, event ticket, or loyalty card and offers to import it into the device's native wallet. No sender markup required — parses PKPass attachments or recognised patterns.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `passenger_name` | string | |
| `flight_number` | string | |
| `departure_airport_iata` | string | |
| `arrival_airport_iata` | string | |
| `departure_datetime` | datetime | |
| `boarding_time` | time (optional) | |
| `gate` | string (optional) | e.g. "B22" |
| `seat_number` | string | |
| `ticket_class` | string (optional) | |
| `booking_reference` | string | |
| `barcode_type` | enum: `qr` \| `aztec` \| `pdf417` \| `code128` | For rendering the scannable code |
| `barcode_data` | string | The actual scannable value |
| `airline_name` | string | |
| `passbook_url` | URL (optional) | `.pkpass` file URL for direct Wallet import |

**Example:**
A user receives a Ryanair boarding pass as a `.pkpass` attachment. Apple Mail shows a banner: "Add to Apple Wallet". One tap and the boarding pass appears in Wallet, ready for the airport scanner — no app download needed.

---

### 22. Priority / Time-Sensitive Callout
The client identifies an email as time-sensitive and surfaces it at the top of the inbox with a visual flag, above all other unread mail.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `deadline_datetime` | datetime | The time that makes this email urgent |
| `urgency_type` | enum: `same_day_event` \| `boarding` \| `offer_expiry` \| `payment_due` \| `deadline` \| `time_limited_offer` | |
| `urgency_label` | string | Human-readable callout, e.g. "Boarding in 2 hours", "Deadline today" |
| `detected_signals` | array of strings | Which keywords or patterns triggered the priority flag |
| `hours_until_deadline` | float | Derived from deadline_datetime; used to determine display urgency |

**Example:**
A user receives a same-day dinner invitation at 8pm. At 5pm, Apple Mail moves it to the top of the inbox under a "Time Sensitive" label, above 40 other unread emails, so it is not missed.

---

## Sending Controls
*Actions the sender configures that affect how or when an email is delivered.*

---

### 23. Scheduled Send
Compose now, deliver at a specified future date and time.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `send_at` | datetime | ISO 8601 with timezone |
| `timezone` | string | IANA timezone — store separately from the datetime |
| `recipient_addresses` | array of strings | To, CC, BCC addresses |
| `subject` | string | |
| `body_html` | string | |
| `body_text` | string | Plain-text fallback |
| `attachments` | array of `{ filename, content_type, size_bytes }` (optional) | |
| `message_id` | string | Internal reference to cancel or reschedule |

**Example:**
A product manager writes a release announcement on Sunday evening but wants it to land in recipients' inboxes at 9am Monday. They write the email, click **Schedule send**, pick Monday 9:00am, and it sends automatically without them needing to be at their desk.

---

### 24. Undo Send
A configurable delay window after hitting Send, during which the message can be recalled before it leaves the server.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | Reference to cancel the send |
| `undo_window_seconds` | integer | How long the recall window is open; typically 5–30 |
| `queued_at` | datetime | When Send was hit |
| `scheduled_release_at` | datetime | When the message will actually leave if not recalled |
| `status` | enum: `pending` \| `sent` \| `cancelled` | Current state |

**Example:**
A user hits Send on an email and immediately notices they forgot to attach the file they referenced. They click **Undo** within the 10-second window. The email is cancelled and returned to Draft, allowing them to attach the file and resend.

---

### 25. Read Receipt
The sender is notified when the recipient opens the email, including the timestamp and in some implementations the device type.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `recipient_email` | string | |
| `opened_at` | datetime | |
| `open_count` | integer | Total number of opens for this message |
| `client_type` | string (optional) | e.g. "Gmail iOS", "Apple Mail macOS" — may be masked by privacy proxies |
| `device_type` | enum: `desktop` \| `mobile` \| `tablet` (optional) | |
| `ip_address` | string (optional) | Will be Apple's proxy IP if Mail Privacy Protection is active |
| `location_city` | string (optional) | Derived from IP — treat as approximate |

**Example:**
A sales rep sends a proposal to a prospect on Tuesday. On Thursday at 11:42am they receive a notification: "Your email to alex@company.com was opened." They now know the prospect has read it and can time a follow-up call accordingly.

---

### 26. Follow-Up Reminder (No Reply)
If no reply is received within a set time, the email resurfaces at the top of the sender's inbox as a prompt to follow up. Triggered by absence of response, not a timer.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `original_message_id` | string | The sent email being watched |
| `recipient_email` | string | |
| `sent_at` | datetime | |
| `trigger_window` | duration string | e.g. "5d", "48h" — time with no reply before reminder fires |
| `reminder_at` | datetime | Computed: sent_at + trigger_window |
| `reminder_label` | string (optional) | Custom label shown when it resurfaces |
| `status` | enum: `watching` \| `replied` \| `reminded` \| `dismissed` | |

**Example:**
A freelancer sends an invoice and sets a 5-day follow-up reminder. If the client does not reply within 5 days, the invoice email reappears at the top of their inbox flagged "No reply — follow up?". They send a polite nudge.

---

### 27. Expiring / Self-Destructing Message
The sender sets a time window. After it expires, the message is automatically deleted or becomes unreadable.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `expires_at` | datetime | When the message self-destructs |
| `deletion_scope` | enum: `server_only` \| `client_only` \| `both` | What gets deleted |
| `warn_before_expiry` | boolean | Whether to notify recipient before deletion |
| `warning_hours_before` | integer (optional) | How many hours ahead to warn, e.g. 24 |
| `expired_placeholder_text` | string (optional) | What to show in place of the message after expiry |

**Example:**
An HR team sends interview feedback to a hiring panel. The email is set to expire in 48 hours to comply with GDPR data minimisation policy. After 48 hours, recipients see "This message has expired and is no longer available."

---

### 28. Encrypted External Delivery
Instead of sending plaintext to a non-encrypted recipient, the system sends a link to a secure web page where the message can be read inside an encrypted session. The email in transit never contains the plaintext.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `secure_message_id` | string | Server-side reference to the encrypted payload |
| `sender_name` | string | |
| `sender_email` | string | |
| `secure_view_url` | URL | Link sent to recipient |
| `expires_at` | datetime (optional) | When the link stops working |
| `auth_method` | enum: `shared_password` \| `date_of_birth` \| `phone_otp` \| `none` | How the recipient proves identity |
| `password_hint` | string (optional) | Displayed before auth; must not itself be sensitive |
| `max_view_count` | integer (optional) | Number of times the link can be opened |
| `notify_on_view` | boolean | Whether sender is notified when recipient opens the message |

**Example:**
A doctor emails test results to a patient who uses a standard Gmail account. Rather than the results appearing in plaintext, the patient receives: "Dr. Müller has sent you a secure message. Click here to read it." They authenticate with their date of birth and read the results in a secure browser session.

---

## Triage & Routing
*How the client automatically organises, surfaces, or filters incoming mail.*

---

### 29. Snooze / Defer
Remove an email from view until a chosen time, at which point it returns to the top of the inbox as if newly arrived.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `snooze_until` | datetime | When the email should reappear |
| `original_arrival_datetime` | datetime | Preserved for display and sorting context |
| `snooze_label` | string (optional) | What is shown when it resurfaces, e.g. "Registration deadline tomorrow" |
| `snoozed_by` | string | Email address of the person who snoozed it |

**Example:**
A user receives an email about a conference registration deadline — but the deadline is in 3 weeks. They snooze it for 2 weeks 6 days. It disappears completely until then, keeping their inbox clean, and reappears the day before the deadline.

---

### 30. Sender Screening / Gating
The first time a new sender emails you, their message is held in a queue. You explicitly approve or block them before any mail from them reaches your inbox.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `sender_email` | string | |
| `sender_display_name` | string | |
| `first_contact_datetime` | datetime | |
| `email_subject` | string | Shown in the screening queue |
| `email_preview` | string | First N characters of body — enough to make a decision |
| `screening_decision` | enum: `pending` \| `approved` \| `blocked` | |
| `decision_datetime` | datetime (optional) | When the user made their choice |
| `applies_to` | enum: `sender_address` \| `sender_domain` | Whether the rule applies to one address or the whole domain |

**Example:**
A freelancer uses HEY. A potential new client emails them for the first time. Rather than landing in the inbox, it hits the Screener queue. The freelancer sees: "First email from mark@acmecorp.com — let them in?" They approve, and all future emails from that sender go straight to the inbox.

---

### 31. Auto-Categorisation
Incoming emails are automatically sorted into named categories using ML — Primary, Transactions, Updates, Promotions — and each category is browsed separately.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `detected_category` | enum: `primary` \| `transactions` \| `updates` \| `promotions` \| `social` \| `forums` | |
| `confidence_score` | float 0–1 | Model's certainty |
| `signals` | array of strings | What triggered the classification, e.g. `["sender_domain:amazon.com", "subject_contains:order confirmation"]` |
| `sender_domain` | string | |
| `sender_email` | string | |
| `user_override_category` | enum (optional) | The category the user manually moved it to |
| `override_apply_to_future` | boolean | Whether the override should train future classifications from this sender |

**Example:**
A user's inbox no longer shows a single chronological list. Order confirmations from Amazon, shipping notices from FedEx, and bank statements all land in "Transactions". Newsletters land in "Updates". Only direct emails from real people land in "Primary". They process each category in a single focused session.

---

### 32. Pipeline / Stage Tracking
Email threads are moved through named custom stages. Gives email a lightweight kanban workflow layer for tracking multi-step processes.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `pipeline_id` | string | |
| `pipeline_name` | string | e.g. "Client Projects" |
| `stages` | ordered array of `{ id, name, colour }` | All stages in sequence |
| `thread_id` | string | Email thread being tracked |
| `current_stage_id` | string | |
| `stage_entered_at` | datetime | When the thread entered the current stage |
| `stage_history` | array of `{ stage_id, entered_at, exited_at, moved_by }` | Full audit trail |
| `assigned_to` | string (optional) | Email address of owner |

**Example:**
A freelancer manages client projects via email. They create a Workflow with stages: **Brief received → Proposal sent → In negotiation → Contract signed → Active**. Each client thread sits at its current stage and can be dragged forward as things progress — no external project tool needed.

---

### 33. Auto-Filing Rules
Multi-condition if/then rules that automatically label, archive, forward, delete, or respond to emails based on sender, subject, headers, or body content.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `rule_id` | string | |
| `rule_name` | string | Human-readable label |
| `conditions` | array of `{ field: from \| to \| subject \| body \| header \| has_attachment, operator: equals \| contains \| starts_with \| matches_regex \| is_greater_than, value }` | |
| `condition_logic` | enum: `AND` \| `OR` | How multiple conditions combine |
| `actions` | array of `{ type: label \| archive \| delete \| forward \| mark_read \| mark_unread \| star \| move_to_folder \| auto_reply \| run_webhook, params }` | What to do when conditions match |
| `priority` | integer | Evaluation order when multiple rules match |
| `active` | boolean | |
| `skip_inbox` | boolean | Whether matched emails bypass the inbox entirely |

**Example:**
A developer sets a rule: "If sender domain is `github.com` AND subject contains `[CI]` → skip inbox, apply label `CI`, mark as read." All GitHub CI notification emails are automatically filed and never clutter the inbox, but remain searchable.

---

### 34. Masked / Alias Address
Generate a unique throwaway email address per service or sender. All mail to that alias arrives in the real inbox, but the alias can be individually blocked or deleted without affecting the real address.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `alias_address` | string | The generated address, e.g. `shop-alias-7f3k@domain.com` |
| `real_address` | string | The underlying inbox it forwards to |
| `alias_label` | string (optional) | Human-readable note, e.g. "Amazon shopping" |
| `created_at` | datetime | |
| `associated_service` | string (optional) | Which site or service it was generated for |
| `status` | enum: `active` \| `blocked` \| `deleted` | |
| `emails_received_count` | integer | Lifetime volume |
| `blocked_at` | datetime (optional) | When it was disabled |
| `forward_to` | string | Destination inbox address |

**Example:**
A user signs up to a new e-commerce site. Instead of giving their real address, they generate `shop-alias-7f3k@domain.com`. Three months later they start receiving spam. They delete that single alias — the spam stops, their real address is unaffected, and no other service is disrupted.

---

### 35. Tracking Pixel Block
The client silently blocks all tracking pixels in incoming emails, preventing senders from knowing if or when the email was opened.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `blocked_pixel_urls` | array of URL strings | All 1×1 tracking images detected |
| `sender_domain` | string | |
| `block_action` | enum: `blocked` \| `proxied` \| `allowed` | What the client did with the pixel request |
| `detected_at` | datetime | |
| `pixel_count` | integer | Number of tracking pixels found in the email |

**Example:**
A user enables Mail Privacy Protection in Apple Mail. Marketing emails from retailers fire tracking pixels, but Apple's proxy pre-loads all remote content before displaying the email. The sender's analytics show the email was "opened" when it was pre-fetched — the real open time and IP address are never exposed.

---

## Collaboration & Delegation
*Actions that involve multiple people coordinating around a shared email thread.*

---

### 36. Assign to Teammate
Mark an email thread as owned by a specific team member. The assignee sees it in their queue; others see it is handled. Prevents double replies.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `thread_id` | string | |
| `assigner_email` | string | |
| `assignee_email` | string | |
| `assignment_note` | string (optional) | Context for the assignee |
| `assigned_at` | datetime | |
| `due_by` | datetime (optional) | Response deadline |
| `priority` | enum: `low` \| `normal` \| `high` \| `urgent` (optional) | |
| `previous_assignee_email` | string (optional) | For re-assignment audit trail |

**Example:**
A shared support@ inbox receives a complex billing dispute. The first responder assigns it to the billing specialist with a note: "Customer has been waiting 3 days, high priority." The thread disappears from the general queue and appears in the specialist's assigned view. No one else replies accidentally.

---

### 37. Internal Thread Comment
A private note attached to an email thread, visible only to the team — not the sender or recipient.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `comment_id` | string | |
| `thread_id` | string | |
| `author_email` | string | |
| `author_display_name` | string | |
| `comment_body` | string | Plain text or markdown |
| `created_at` | datetime | |
| `edited_at` | datetime (optional) | |
| `mentions` | array of email strings (optional) | @-mentioned teammates |
| `visibility` | enum: `all_members` \| `specific_members` | |
| `visible_to` | array of email strings (optional) | Required if visibility = specific_members |

**Example:**
A sales team receives an angry email from a key client. Before replying, a team member adds an internal comment: "This is related to the outage last Tuesday — check ticket #8821 before responding." The eventual reply is informed without the client seeing the internal context.

---

### 38. Collaborative Draft
Multiple people edit the same draft reply simultaneously, like a shared document, before it is sent.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `draft_id` | string | |
| `thread_id` | string | The email being replied to |
| `collaborators` | array of `{ email, display_name, can_edit, can_comment }` | |
| `current_subject` | string | |
| `current_body_html` | string | Live state of the draft |
| `last_edited_by` | string | Email of last editor |
| `last_edited_at` | datetime | |
| `edit_history` | array of `{ author_email, timestamp, change_summary }` | For audit and conflict resolution |
| `status` | enum: `in_progress` \| `ready_to_send` \| `sent` | |
| `locked_by` | string (optional) | Email of whoever has the draft open for editing, to prevent conflicts |

**Example:**
A startup receives a partnership proposal from a major retailer. The CEO, legal lead, and head of sales all need to sign off on the reply. Instead of forwarding the draft three times, all three edit a single shared draft in real time, each adding their section. When all are happy, one person hits Send.

---

### 39. Shared Inbox
A team-visible mailbox for role addresses (support@, sales@, info@). Members see ownership, assignment status, and internal comments — no forwarded alias chaos.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `inbox_address` | string | e.g. `support@company.com` |
| `inbox_display_name` | string | |
| `members` | array of `{ email, display_name, role: agent \| admin }` | |
| `thread_id` | string | |
| `status` | enum: `open` \| `claimed` \| `assigned` \| `pending_reply` \| `resolved` \| `closed` | |
| `owner_email` | string (optional) | Who currently owns the thread |
| `claimed_at` | datetime (optional) | |
| `resolved_at` | datetime (optional) | |
| `first_response_at` | datetime (optional) | For SLA tracking |
| `response_count` | integer | Number of replies sent |

**Example:**
A five-person support team all have access to support@company.com. When a ticket arrives, it appears for everyone. One agent claims it, and it moves to their queue. Others see "Claimed by Priya". No one duplicates the response. Managers can see throughput per agent.

---

## AI & Intelligence

---

### 41. Thread Summary
A collapsed plain-language summary of a long email thread, shown before or instead of reading the full chain. Reduces context-loading time.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `thread_id` | string | |
| `message_count` | integer | Total messages in the thread |
| `date_range_start` | datetime | Timestamp of first message |
| `date_range_end` | datetime | Timestamp of most recent message |
| `participants` | array of `{ email, display_name }` | All people in the thread |
| `summary_text` | string | Generated plain-text summary |
| `key_decisions` | array of strings (optional) | Extracted decisions made in the thread |
| `action_items` | array of strings (optional) | Extracted to-dos or next steps |
| `generated_at` | datetime | When the summary was produced |
| `token_count` | integer (optional) | Input token usage, for cost tracking |

**Example:**
A user returns from a week's holiday to find a 34-email thread about a product decision. Instead of reading every message, they click **Summarise**. The client returns: "The team debated between Option A (faster to ship) and Option B (more scalable). Option B was chosen. Next step: engineering kick-off on Monday." They are fully up to speed in 10 seconds.

---

### 42. AI Reply Draft
The client generates a full draft reply based on the email content and (in some implementations) the user's prior writing style. The user reviews, edits, and sends.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `thread_id` | string | |
| `trigger_message_id` | string | The specific message being replied to |
| `draft_body` | string | Generated draft text |
| `draft_subject` | string (optional) | If subject needs changing, e.g. "Re: ..." |
| `tone` | enum: `formal` \| `neutral` \| `friendly` (optional) | Requested or inferred tone |
| `style_source` | string (optional) | e.g. "learned from your last 90 days of sent mail" |
| `generated_at` | datetime | |
| `alternatives` | array of strings (optional) | Other draft options if multiple were generated |
| `confidence` | float 0–1 (optional) | Model's confidence in relevance of the draft |

**Example:**
A consultant receives an email asking for their availability for a call next week. The client auto-generates: "Hi Sarah, thanks for reaching out — I have availability on Tuesday 27 May from 2pm–4pm or Thursday 29 May from 10am–12pm. Let me know what works for you." The consultant adjusts the times, hits Send. Total time: 8 seconds.

---

### 43. Priority Surfacing
The client identifies which emails are time-sensitive or high-importance using ML and surfaces them first — above all other unread mail, regardless of arrival time.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `message_id` | string | |
| `priority_score` | float 0–1 | 1.0 = highest priority |
| `priority_label` | enum: `urgent` \| `high` \| `normal` \| `low` | Bucketed from score |
| `signals` | array of `{ type: sender_importance \| subject_keyword \| deadline_detected \| reply_chain_age \| vip_sender \| calendar_conflict, description }` | What drove the score |
| `deadline_extracted` | datetime (optional) | If a specific deadline was found in the email |
| `surfaced_at` | datetime | When the client moved it to the top |
| `user_dismissed` | boolean | Whether the user manually deprioritised it |

**Example:**
A user has 80 unread emails. Among them is a message from their biggest client with "Urgent: contract issue" in the subject. The client's AI puts this at the very top of the inbox, ahead of all 79 others. The user sees it the moment they open the app.

---

### 44. Smart Reply Suggestions
The client analyses the incoming email and surfaces 2–3 short suggested replies the user can send with a single tap — without composing anything.

**Data to extract:**
| Field | Type | Notes |
|---|---|---|
| `thread_id` | string | |
| `trigger_message_id` | string | The message the suggestions respond to |
| `suggestions` | array of `{ id, text, tone: affirmative \| negative \| deferring }` | 2–4 options |
| `generated_at` | datetime | |
| `context_summary` | string (optional) | Brief description of what the model read to generate suggestions |
| `selected_suggestion_id` | string (optional) | Which suggestion the user picked, for training feedback |

**Example:**
A user receives a meeting request: "Can we move our call to Thursday?" Apple Mail shows three suggestion chips: **"Sure, Thursday works"** / **"Sorry, I'm not free Thursday"** / **"Let me check and get back to you"**. The user taps the first one. A reply is sent in one tap with no typing.

---

## Quick Reference Index

| # | Action | Type |
|---|---|---|
| 1 | One-Click Confirm | In-email interactive |
| 2 | Approve / Reject | In-email interactive |
| 3 | Vote / Poll | In-email interactive |
| 4 | RSVP | In-email interactive |
| 5 | Flight Check-In | In-email interactive |
| 6 | Save Offer / Coupon | In-email interactive |
| 7 | Add to Queue / Playlist | In-email interactive |
| 8 | Rate & Review | In-email interactive |
| 9 | Survey / Form | In-email interactive |
| 10 | View Reservation / Booking | In-email interactive |
| 11 | Track Package | In-email interactive |
| 12 | Password-Protected Delivery | In-email interactive |
| 13 | Flight Highlights | Informational callout |
| 14 | Hotel Reservation Highlights | Informational callout |
| 15 | Transportation Highlights | Informational callout |
| 16 | Order Highlights | Informational callout |
| 17 | Real-Time Shipment Status Badge | Informational callout |
| 18 | Event Highlights | Informational callout |
| 19 | Verification Code Callout | Informational callout |
| 20 | Add to Calendar (Auto) | Informational callout |
| 21 | Boarding Pass / Wallet Import | Informational callout |
| 22 | Priority / Time-Sensitive Callout | Informational callout |
| 23 | Scheduled Send | Sending control |
| 24 | Undo Send | Sending control |
| 25 | Read Receipt | Sending control |
| 26 | Follow-Up Reminder (No Reply) | Sending control |
| 27 | Expiring / Self-Destructing Message | Sending control |
| 28 | Encrypted External Delivery | Sending control |
| 29 | Snooze / Defer | Triage & routing |
| 30 | Sender Screening / Gating | Triage & routing |
| 31 | Auto-Categorisation | Triage & routing |
| 32 | Pipeline / Stage Tracking | Triage & routing |
| 33 | Auto-Filing Rules | Triage & routing |
| 34 | Masked / Alias Address | Triage & routing |
| 35 | Tracking Pixel Block | Triage & routing |
| 36 | Assign to Teammate | Collaboration |
| 37 | Internal Thread Comment | Collaboration |
| 38 | Collaborative Draft | Collaboration |
| 39 | Shared Inbox | Collaboration |
| 41 | Thread Summary | AI & intelligence |
| 42 | AI Reply Draft | AI & intelligence |
| 43 | Priority Surfacing | AI & intelligence |
| 44 | Smart Reply Suggestions | AI & intelligence |
