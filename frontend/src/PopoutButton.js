import OpenInNew from "@mui/icons-material/OpenInNew";
import ToggleButton from '@mui/material/ToggleButton';


const PopoutButton = ({ color, href }) => {
    return (
        <ToggleButton color={color} selected={false} href={href} target="_blank">
            <OpenInNew />
        </ToggleButton>
    );
};


export default PopoutButton;
